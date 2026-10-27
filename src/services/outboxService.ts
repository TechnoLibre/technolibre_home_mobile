import { v4 as uuidv4 } from "uuid";
import { DatabaseService, OutboxOp, OutboxStatus } from "./databaseService";
import type { SyncCredentials } from "./odoo/odooRpcClient";

/** Delay before the first retry; each later failure doubles it. */
const RETRY_BASE_MS = 30 * 1000;
/** Longest delay between two automatic retries. */
export const RETRY_MAX_MS = 60 * 60 * 1000;

/**
 * Raised by a handler when the server refuses an operation for a reason a
 * retry does not fix: the operation turns "blocked" and waits for the user.
 * attempt() stores reason and candidates in the row's params
 * (blockedReason, candidates), so the block can be explained later.
 * candidates: remote ids the user can pick from ("ambiguous").
 */
export class OutboxBlockedError extends Error {
  /**
   * opKind: the outbox kind of the blocked operation, when known; opId:
   * its id, for a kind a note can have several of on one server.
   */
  constructor(
    message: string,
    readonly reason: string,
    readonly candidates: number[] = [],
    readonly opKind: string | null = null,
    readonly opId: string | null = null
  ) {
    super(message);
  }
}

/**
 * Raised by a handler that must not contact the server before retryAt.
 * The run does not count as an attempt: attempts stays as it was, and the
 * row waits until retryAt (params.notBefore) even when a sync is forced.
 */
export class OutboxRetryLaterError extends Error {
  constructor(message: string, readonly retryAt: string) {
    super(message);
  }
}

/**
 * Raised by a handler that must wait for a condition of its own (heldFor
 * names it) before it contacts the server. Not an attempt and not a
 * failure: the row stays queued with its attempts, gets no retry delay and
 * schedules no retry; the next drain runs the handler again, forced or
 * not, and the handler decides again whether to hold.
 */
export class OutboxHeldError extends Error {
  constructor(message: string, readonly heldFor: string) {
    super(message);
  }
}

/**
 * Runs one operation against its server. A handler wraps its work in
 * OutboxService.attempt(), which counts the attempt and settles the row;
 * it may instead delegate to a service that does so itself.
 */
export type OutboxHandler = (creds: SyncCredentials, op: OutboxOp) => Promise<void>;

export interface DrainResult {
  done: number;
  failed: number;
  blocked: number;
  /** Operations whose handler held them (OutboxHeldError). */
  held: number;
  errors: string[];
}

/**
 * The operations with each one after the operation it depends on, when that
 * one is in the list; otherwise in the given order (the database's: oldest
 * first, then by id). Operations created in the same millisecond tie on
 * their creation time and their random ids may sort a dependent first: in
 * this order a dependent still runs in the pass its dependency succeeds in.
 * A dependency cycle is broken where the walk meets it again.
 */
export function dependencyOrder(ops: OutboxOp[]): OutboxOp[] {
  const byId = new Map(ops.map((op) => [op.id, op]));
  const placed = new Set<string>();
  const ordered: OutboxOp[] = [];
  for (const op of ops) {
    const chain: OutboxOp[] = [];
    const seen = new Set<string>();
    for (let cur: OutboxOp | undefined = op; cur && !placed.has(cur.id) && !seen.has(cur.id);
      cur = cur.dependsOn ? byId.get(cur.dependsOn) : undefined) {
      seen.add(cur.id);
      chain.push(cur);
    }
    for (const o of chain.reverse()) {
      placed.add(o.id);
      ordered.push(o);
    }
  }
  return ordered;
}

/** Delay before the retry that follows the given number of attempts. */
export function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

/**
 * The sync outbox: the operations a note still has to apply on a server,
 * stored in sync_outbox so they survive being offline and an app restart.
 *
 * Each row keeps its client_uuid across retries. attempt() persists the
 * attempt count and the "running" status BEFORE the handler talks to the
 * server, so a run cut short (answer lost, app killed) is seen by the next
 * run as attempts > 0: the handler then looks for its client_uuid on the
 * server before acting again. Success deletes the row; failure schedules a
 * retry after retryDelayMs; OutboxBlockedError parks the row until the
 * user acts.
 */
export class OutboxService {
  private handlers = new Map<string, OutboxHandler>();
  /** In-flight attempt per operation id: two runs of one operation never overlap. */
  private inFlight = new Map<string, Promise<void>>();
  /** Called with next_attempt_at each time a row turns failed. */
  onRetryScheduled: ((nextAttemptAt: string) => void) | null = null;

  constructor(private db: DatabaseService, private now: () => Date = () => new Date()) {}

  registerHandler(kind: string, handler: OutboxHandler): void {
    this.handlers.set(kind, handler);
  }

  /**
   * Adds an operation; status "incomplete" when a choice is still missing,
   * "blocked" for a notice stored given up at once (with its lastError).
   */
  async enqueue(input: {
    noteId: string;
    configId: string;
    kind: string;
    params?: Record<string, any>;
    dependsOn?: string | null;
    status?: Extract<OutboxStatus, "queued" | "incomplete" | "blocked">;
    lastError?: string | null;
  }): Promise<OutboxOp> {
    const at = this.now().toISOString();
    const op: OutboxOp = {
      id: uuidv4(),
      clientUuid: uuidv4(),
      noteId: input.noteId,
      configId: input.configId,
      kind: input.kind,
      params: input.params ?? {},
      status: input.status ?? "queued",
      attempts: 0,
      nextAttemptAt: null,
      lastError: input.lastError ?? null,
      dependsOn: input.dependsOn ?? null,
      createdAt: at,
      updatedAt: at,
    };
    await this.db.addOutboxOp(op);
    return op;
  }

  /** The note's oldest operation of this kind on this server, if any. */
  async find(noteId: string, configId: string, kind: string): Promise<OutboxOp | null> {
    return (await this.db.getOutboxOpsForNote(noteId))
      .find((op) => op.configId === configId && op.kind === kind) ?? null;
  }

  /** All the note's operations of this kind on this server, oldest first. */
  async findAll(noteId: string, configId: string, kind: string): Promise<OutboxOp[]> {
    return (await this.db.getOutboxOpsForNote(noteId))
      .filter((op) => op.configId === configId && op.kind === kind);
  }

  /** find(), or a new queued operation when there is none. */
  async ensure(
    noteId: string,
    configId: string,
    kind: string,
    params: Record<string, any> = {}
  ): Promise<OutboxOp> {
    return (await this.find(noteId, configId, kind))
      ?? this.enqueue({ noteId, configId, kind, params });
  }

  /** Fills in the missing choices of an "incomplete" operation and queues it. */
  async complete(opId: string, params: Record<string, any>): Promise<void> {
    const op = await this.db.getOutboxOp(opId);
    if (!op) return;
    await this.db.updateOutboxOp(opId, {
      params: { ...op.params, ...params },
      status: "queued",
      lastError: null,
      nextAttemptAt: null,
      updatedAt: this.now().toISOString(),
    });
  }

  /**
   * Parks an operation as "incomplete": it waits for a choice the user
   * has not made yet (complete() queues it again). params are merged into
   * the stored ones; the last error is cleared, the row having no failure
   * to report.
   */
  async markIncomplete(opId: string, params: Record<string, any> = {}): Promise<void> {
    const op = await this.db.getOutboxOp(opId);
    if (!op) return;
    await this.db.updateOutboxOp(opId, {
      status: "incomplete",
      params: { ...op.params, ...params },
      lastError: null,
      nextAttemptAt: null,
      updatedAt: this.now().toISOString(),
    });
  }

  /** Puts a "blocked" or "failed" operation back in the queue, due now. */
  async retry(opId: string): Promise<void> {
    await this.db.updateOutboxOp(opId, {
      status: "queued", nextAttemptAt: null, updatedAt: this.now().toISOString(),
    });
  }

  async cancel(opId: string): Promise<void> {
    await this.db.deleteOutboxOp(opId);
  }

  /** See DatabaseService.failInterruptedOutboxOps; call once at startup. */
  async recoverInterrupted(): Promise<number> {
    return this.db.failInterruptedOutboxOps(this.now().toISOString());
  }

  /**
   * Runs work for one operation as one attempt. Reloads the row first and
   * returns without running when it is gone (done meanwhile, note
   * deleted). work receives the row with its attempts count already
   * incremented and persisted: attempts > 1 means an earlier run may have
   * reached the server. Resolves when work succeeded and the row is
   * deleted; rethrows work's error after recording it.
   */
  async attempt(opId: string, work: (op: OutboxOp) => Promise<void>): Promise<void> {
    const previous = this.inFlight.get(opId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.attemptNow(opId, work));
    this.inFlight.set(opId, current);
    try {
      await current;
    } finally {
      if (this.inFlight.get(opId) === current) this.inFlight.delete(opId);
    }
  }

  private async attemptNow(opId: string, work: (op: OutboxOp) => Promise<void>): Promise<void> {
    const stored = await this.db.getOutboxOp(opId);
    if (!stored) return;
    const startedAt = this.now().toISOString();
    const op: OutboxOp = { ...stored, attempts: stored.attempts + 1, status: "running", updatedAt: startedAt };
    await this.db.updateOutboxOp(opId, { attempts: op.attempts, status: "running", updatedAt: startedAt });
    try {
      await work(op);
    } catch (e: unknown) {
      await this.recordFailure(stored, op, e);
      throw e;
    }
    await this.db.deleteOutboxOp(opId);
  }

  /**
   * Merges values into a row's params, read fresh from the database. For
   * a handler that must record something before it contacts the server.
   */
  async setParams(opId: string, values: Record<string, any>): Promise<void> {
    const op = await this.db.getOutboxOp(opId);
    if (!op) return;
    await this.db.updateOutboxOp(opId, { params: { ...op.params, ...values }, updatedAt: this.now().toISOString() });
  }

  /**
   * Writes a row blocked as a handler's OutboxBlockedError leaves it: its
   * reason and candidates in the params read fresh, no next attempt. For a
   * handler that must show the row blocked inside a task of its own, then
   * throws the same error (written again, the same).
   */
  async markBlocked(opId: string, e: OutboxBlockedError): Promise<void> {
    const op = await this.db.getOutboxOp(opId);
    if (!op) return;
    const { heldFor: _heldFor, ...params } = op.params;
    await this.db.updateOutboxOp(opId, {
      status: "blocked",
      lastError: e.message,
      nextAttemptAt: null,
      params: { ...params, blockedReason: e.reason, candidates: e.candidates },
      updatedAt: this.now().toISOString(),
    });
  }

  private async recordFailure(stored: OutboxOp, op: OutboxOp, e: unknown): Promise<void> {
    if (e instanceof OutboxBlockedError) return this.markBlocked(op.id, e);
    const message = e instanceof Error ? e.message : String(e);
    const at = this.now();
    const { heldFor: _heldFor, ...params } = (await this.db.getOutboxOp(op.id))?.params ?? op.params;
    if (e instanceof OutboxHeldError) {
      // Written as queued, not left running: a kill after this point must not make the row look interrupted
      await this.db.updateOutboxOp(op.id, {
        status: "queued",
        attempts: stored.attempts,
        lastError: null,
        nextAttemptAt: null,
        params: { ...params, heldFor: e.heldFor },
        updatedAt: at.toISOString(),
      });
      return;
    }
    let nextAttemptAt: string;
    if (e instanceof OutboxRetryLaterError) {
      // Not an attempt: the server was not contacted
      nextAttemptAt = e.retryAt;
      await this.db.updateOutboxOp(op.id, {
        status: "failed",
        attempts: stored.attempts,
        lastError: message,
        nextAttemptAt,
        params: { ...params, notBefore: e.retryAt },
        updatedAt: at.toISOString(),
      });
    } else {
      nextAttemptAt = new Date(at.getTime() + retryDelayMs(op.attempts)).toISOString();
      await this.db.updateOutboxOp(op.id, {
        status: "failed", lastError: message, nextAttemptAt, params, updatedAt: at.toISOString(),
      });
    }
    this.onRetryScheduled?.(nextAttemptAt);
  }

  /**
   * Whether drain would run this operation now. force skips the retry
   * delay but not params.notBefore. A time more than RETRY_MAX_MS ahead
   * was computed under a clock that ran fast and counts as due, so a
   * corrected clock does not park the row.
   */
  isDue(op: OutboxOp, force = false): boolean {
    if (op.status === "blocked" || op.status === "incomplete") return false;
    if (this.inFlight.has(op.id)) return false;
    const now = this.now().getTime();
    const pending = (at: string | null | undefined) => {
      if (!at) return false;
      const t = new Date(at).getTime();
      return t > now && t - now <= RETRY_MAX_MS;
    };
    if (pending(op.params.notBefore)) return false;
    return force || !pending(op.nextAttemptAt);
  }

  /**
   * Runs, oldest first and each after its dependency (see
   * dependencyOrder), the due operations of one server (see isDue;
   * force ignores the retry delay) whose dependency is done and whose
   * kind has a handler. An operation of a note in skipNoteIds is left for
   * later: the caller already ran that note in this pass. With
   * onlyNoteIds, only the operations of those notes run. An operation
   * of a kind in skipKinds is not run (its caller runs it elsewhere) and,
   * like a held one, keeps its dependents waiting. A failure is counted
   * and the next operation still runs.
   */
  async drain(
    creds: SyncCredentials,
    configId: string,
    options: {
      force?: boolean; skipNoteIds?: Set<string>; onlyNoteIds?: Set<string>; skipKinds?: Set<string>;
    } = {}
  ): Promise<DrainResult> {
    const result: DrainResult = { done: 0, failed: 0, blocked: 0, held: 0, errors: [] };
    const ops = dependencyOrder(await this.db.getOutboxOpsForConfig(configId));
    const pendingIds = new Set(ops.map((op) => op.id));
    for (const op of ops) {
      if (options.skipNoteIds?.has(op.noteId)) continue;
      if (options.onlyNoteIds && !options.onlyNoteIds.has(op.noteId)) continue;
      if (!this.isDue(op, options.force)) continue;
      if (op.dependsOn && pendingIds.has(op.dependsOn)) continue;
      const handler = this.handlers.get(op.kind);
      if (!handler) continue;
      if (options.skipKinds?.has(op.kind)) continue;
      try {
        await handler(creds, op);
        pendingIds.delete(op.id);
        result.done++;
      } catch (e: unknown) {
        if (e instanceof OutboxHeldError) {
          result.held++;
          // A handler that held before attempt() has not recorded it
          const row = await this.db.getOutboxOp(op.id);
          if (row && (row.params.heldFor !== e.heldFor || row.nextAttemptAt || row.lastError)) {
            await this.db.updateOutboxOp(op.id, {
              params: { ...row.params, heldFor: e.heldFor },
              lastError: null,
              nextAttemptAt: null,
              updatedAt: this.now().toISOString(),
            });
          }
          continue;
        }
        if (e instanceof OutboxBlockedError) result.blocked++;
        else result.failed++;
        result.errors.push(`${op.kind} ${op.noteId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return result;
  }

  /**
   * Earliest next_attempt_at among the failed rows of one server that wait
   * out a retry delay, or null: when an automatic retry is next due.
   */
  async nextRetryAt(configId: string): Promise<string | null> {
    const latest = new Date(this.now().getTime() + RETRY_MAX_MS).toISOString();
    return (await this.db.getOutboxOpsForConfig(configId))
      .filter((op) => op.status === "failed" && op.nextAttemptAt)
      .map((op) => (op.nextAttemptAt! > latest ? latest : op.nextAttemptAt!))
      .sort()
      .at(0) ?? null;
  }
}
