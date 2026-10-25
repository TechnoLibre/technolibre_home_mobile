import { describe, it, expect, beforeEach } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { DatabaseService } from "../services/databaseService";
import { OutboxBlockedError, OutboxRetryLaterError, OutboxService, RETRY_MAX_MS, retryDelayMs } from "../services/outboxService";
import type { SyncCredentials } from "../services/odoo/odooRpcClient";
import { addSyncOutboxTable } from "../services/migrations/addSyncOutboxTable";

const CREDS: SyncCredentials = { odooUrl: "https://odoo.example.com", username: "u", password: "p", database: "db" };
const CONFIG = "https://odoo.example.com|u|db";
const OTHER = "https://other.example.com|u|db";

describe("OutboxService", () => {
  let db: DatabaseService;
  let clock: Date;
  let outbox: OutboxService;

  beforeEach(async () => {
    SecureStoragePlugin._store.clear();
    db = new DatabaseService();
    await db.initialize();
    await db.createSyncOutboxTable();
    clock = new Date("2026-10-23T10:00:00.000Z");
    outbox = new OutboxService(db, () => clock);
  });

  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

  it("doubles the retry delay from 30 s up to one hour", () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(retryDelayMs(20)).toBe(3_600_000);
  });

  it("enqueues a row with its own client uuid, kept across reloads", async () => {
    const op = await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "k", params: { a: 1 } });
    const stored = await db.getOutboxOp(op.id);
    expect(stored).toMatchObject({ noteId: "n1", configId: CONFIG, kind: "k", params: { a: 1 }, status: "queued", attempts: 0 });
    expect(stored!.clientUuid).toBe(op.clientUuid);
    expect(op.clientUuid).not.toBe(op.id);
  });

  it("ensure returns the existing row of a note, server and kind", async () => {
    const first = await outbox.ensure("n1", CONFIG, "k");
    expect((await outbox.ensure("n1", CONFIG, "k")).id).toBe(first.id);
    expect((await outbox.ensure("n1", OTHER, "k")).id).not.toBe(first.id);
    expect((await outbox.ensure("n1", CONFIG, "other")).id).not.toBe(first.id);
  });

  it("persists the attempt as running before the work talks to the server", async () => {
    const op = await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "k" });
    let seen: any;
    await outbox.attempt(op.id, async (running) => {
      seen = { passed: running.attempts, stored: await db.getOutboxOp(op.id) };
    });
    expect(seen.passed).toBe(1);
    expect(seen.stored).toMatchObject({ status: "running", attempts: 1 });
    expect(await db.getOutboxOp(op.id)).toBeNull();
  });

  it("records a failure with its message and the next retry time, then rethrows", async () => {
    const op = await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "k" });
    await expect(outbox.attempt(op.id, async () => { throw new Error("down"); })).rejects.toThrow("down");
    await expect(outbox.attempt(op.id, async () => { throw new Error("down"); })).rejects.toThrow("down");
    expect(await db.getOutboxOp(op.id)).toMatchObject({
      status: "failed", attempts: 2, lastError: "down",
      nextAttemptAt: new Date(clock.getTime() + 60_000).toISOString(),
    });
  });

  it("blocks on OutboxBlockedError, with no retry time", async () => {
    const op = await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "k" });
    await expect(outbox.attempt(op.id, async () => { throw new OutboxBlockedError("two matches", "ambiguous"); }))
      .rejects.toBeInstanceOf(OutboxBlockedError);
    expect(await db.getOutboxOp(op.id)).toMatchObject({ status: "blocked", lastError: "two matches", nextAttemptAt: null });
  });

  it("skips the work of a row deleted meanwhile", async () => {
    const op = await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "k" });
    await outbox.cancel(op.id);
    let ran = false;
    await outbox.attempt(op.id, async () => { ran = true; });
    expect(ran).toBe(false);
  });

  it("never overlaps two attempts of one row", async () => {
    const op = await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "k" });
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = outbox.attempt(op.id, async () => { order.push("first:start"); await gate; order.push("first:end"); });
    const second = outbox.attempt(op.id, async () => { order.push("second"); });
    await Promise.resolve(); await Promise.resolve();
    release();
    await Promise.all([first, second]);
    // The first run deleted the row: the second one finds nothing to do
    expect(order).toEqual(["first:start", "first:end"]);
  });

  describe("drain", () => {
    const record = (ran: string[]) => (_c: SyncCredentials, op: any) =>
      outbox.attempt(op.id, async () => { ran.push(op.params.tag); });

    it("runs the due rows of one server, oldest first", async () => {
      const ran: string[] = [];
      outbox.registerHandler("k", record(ran));
      await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "k", params: { tag: "a" } });
      advance(1);
      await outbox.enqueue({ noteId: "n2", configId: CONFIG, kind: "k", params: { tag: "b" } });
      await outbox.enqueue({ noteId: "n3", configId: OTHER, kind: "k", params: { tag: "other" } });

      const result = await outbox.drain(CREDS, CONFIG);
      expect(ran).toEqual(["a", "b"]);
      expect(result).toMatchObject({ done: 2, failed: 0, blocked: 0 });
      expect(await db.getOutboxOpsForConfig(OTHER)).toHaveLength(1);
    });

    it("waits out the retry delay unless forced", async () => {
      const ran: string[] = [];
      const op = await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "k", params: { tag: "a" } });
      await outbox.attempt(op.id, async () => { throw new Error("x"); }).catch(() => {});
      outbox.registerHandler("k", record(ran));

      await outbox.drain(CREDS, CONFIG);
      expect(ran).toEqual([]);
      advance(30_000);
      await outbox.drain(CREDS, CONFIG);
      expect(ran).toEqual(["a"]);

      const again = await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "k", params: { tag: "b" } });
      await outbox.attempt(again.id, async () => { throw new Error("x"); }).catch(() => {});
      await outbox.drain(CREDS, CONFIG, { force: true });
      expect(ran).toEqual(["a", "b"]);
    });

    it("leaves blocked and incomplete rows, rows without handler, and skipped notes", async () => {
      const ran: string[] = [];
      outbox.registerHandler("k", record(ran));
      const blocked = await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "k", params: { tag: "blocked" } });
      await outbox.attempt(blocked.id, async () => { throw new OutboxBlockedError("no", "x"); }).catch(() => {});
      await outbox.enqueue({ noteId: "n2", configId: CONFIG, kind: "k", params: { tag: "incomplete" }, status: "incomplete" });
      await outbox.enqueue({ noteId: "n3", configId: CONFIG, kind: "unknown", params: { tag: "unknown" } });
      await outbox.enqueue({ noteId: "n4", configId: CONFIG, kind: "k", params: { tag: "skipped" } });

      await outbox.drain(CREDS, CONFIG, { force: true, skipNoteIds: new Set(["n4"]) });
      expect(ran).toEqual([]);
      expect(await db.getOutboxOpsForConfig(CONFIG)).toHaveLength(4);
    });

    it("onlyNoteIds restricts a drain to those notes", async () => {
      const ran: string[] = [];
      outbox.registerHandler("k", record(ran));
      await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "k", params: { tag: "a" } });
      await outbox.enqueue({ noteId: "chat", configId: CONFIG, kind: "k", params: { tag: "c" } });

      await outbox.drain(CREDS, CONFIG, { onlyNoteIds: new Set(["chat"]) });
      expect(ran).toEqual(["c"]);
      expect(await db.getOutboxOpsForConfig(CONFIG)).toHaveLength(1);
    });

    it("runs a row only once the row it depends on is done", async () => {
      const ran: string[] = [];
      outbox.registerHandler("k", record(ran));
      outbox.registerHandler("failing", (_c, op) => outbox.attempt(op.id, async () => { throw new Error("x"); }));
      const parent = await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "failing" });
      advance(1);
      await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "k", params: { tag: "child" }, dependsOn: parent.id });

      const result = await outbox.drain(CREDS, CONFIG);
      expect(ran).toEqual([]);
      expect(result).toMatchObject({ done: 0, failed: 1 });

      await outbox.cancel(parent.id);
      await outbox.drain(CREDS, CONFIG);
      expect(ran).toEqual(["child"]);
    });

    it("runs the dependent row in the same pass when its parent succeeds", async () => {
      const ran: string[] = [];
      outbox.registerHandler("k", record(ran));
      const parent = await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "k", params: { tag: "parent" } });
      advance(1);
      await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "k", params: { tag: "child" }, dependsOn: parent.id });
      await outbox.drain(CREDS, CONFIG);
      expect(ran).toEqual(["parent", "child"]);
    });

    it("counts a blocked row apart from a failed one", async () => {
      outbox.registerHandler("b", (_c, op) => outbox.attempt(op.id, async () => { throw new OutboxBlockedError("b", "x"); }));
      await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "b" });
      const result = await outbox.drain(CREDS, CONFIG);
      expect(result).toMatchObject({ done: 0, failed: 0, blocked: 1 });
      expect(result.errors[0]).toContain("b n1");
    });
  });

  it("does not count a retry-later run as an attempt, and keeps the row waiting even when forced", async () => {
    const op = await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "k" });
    await outbox.attempt(op.id, async () => { throw new Error("down"); }).catch(() => {});
    const until = new Date(clock.getTime() + 120_000).toISOString();
    await expect(outbox.attempt(op.id, async () => { throw new OutboxRetryLaterError("wait", until); }))
      .rejects.toBeInstanceOf(OutboxRetryLaterError);
    const stored = (await db.getOutboxOp(op.id))!;
    expect(stored).toMatchObject({ status: "failed", attempts: 1, nextAttemptAt: until, params: { notBefore: until } });
    expect(outbox.isDue(stored, true)).toBe(false);
    advance(120_001);
    expect(outbox.isDue(stored, false)).toBe(true);
  });

  it("keeps what a handler stored with setParams when the attempt then fails", async () => {
    const op = await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "k", params: { a: 1 } });
    await outbox.attempt(op.id, async () => {
      await outbox.setParams(op.id, { sentAt: "x" });
      throw new Error("lost answer");
    }).catch(() => {});
    expect((await db.getOutboxOp(op.id))!.params).toEqual({ a: 1, sentAt: "x" });
  });

  it("treats a retry time beyond the longest delay as due (clock corrected backwards)", async () => {
    const op = await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "k" });
    const far = new Date(clock.getTime() + 40 * 24 * 3600 * 1000).toISOString();
    await db.updateOutboxOp(op.id, { status: "failed", nextAttemptAt: far, updatedAt: clock.toISOString() });
    const stored = (await db.getOutboxOp(op.id))!;
    expect(outbox.isDue(stored)).toBe(true);
    expect(await outbox.nextRetryAt(CONFIG)).toBe(new Date(clock.getTime() + RETRY_MAX_MS).toISOString());
  });

  it("reports each newly scheduled retry", async () => {
    const seen: string[] = [];
    outbox.onRetryScheduled = (at) => seen.push(at);
    const op = await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "k" });
    await outbox.attempt(op.id, async () => { throw new Error("x"); }).catch(() => {});
    await outbox.attempt(op.id, async () => { throw new OutboxBlockedError("b", "x"); }).catch(() => {});
    expect(seen).toEqual([new Date(clock.getTime() + 30_000).toISOString()]);
    expect(await outbox.nextRetryAt(CONFIG)).toBeNull();
  });

  it("completes an incomplete row and queues it", async () => {
    const op = await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "k", params: { model: "res.partner" }, status: "incomplete" });
    await outbox.complete(op.id, { resId: 5 });
    expect(await db.getOutboxOp(op.id)).toMatchObject({ status: "queued", params: { model: "res.partner", resId: 5 } });
  });

  it("puts a blocked row back in the queue on retry", async () => {
    const op = await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "k" });
    await outbox.attempt(op.id, async () => { throw new OutboxBlockedError("no", "x"); }).catch(() => {});
    await outbox.retry(op.id);
    expect(outbox.isDue((await db.getOutboxOp(op.id))!)).toBe(true);
  });

  it("turns rows left running by a killed app into failed rows, due now, attempts kept", async () => {
    const op = await outbox.enqueue({ noteId: "n1", configId: CONFIG, kind: "k" });
    await db.updateOutboxOp(op.id, { status: "running", attempts: 1, updatedAt: clock.toISOString() });
    expect(await outbox.recoverInterrupted()).toBe(1);
    const stored = await db.getOutboxOp(op.id);
    expect(stored).toMatchObject({ status: "failed", attempts: 1, lastError: "interrupted" });
    expect(outbox.isDue(stored!)).toBe(true);
  });
});

describe("migration 2026102202", () => {
  it("creates the outbox and probe tables and adds client_uuid to an older note_links", async () => {
    SecureStoragePlugin._store.clear();
    const db = new DatabaseService();
    await db.initialize();
    // note_links as migration 2026102201 created it on installs that ran it first
    await (db as any).db.execute(`CREATE TABLE IF NOT EXISTS note_links (
      id TEXT PRIMARY KEY NOT NULL, note_id TEXT NOT NULL, config_id TEXT NOT NULL, model TEXT NOT NULL,
      res_id INTEGER NOT NULL, kind TEXT NOT NULL, remote_state TEXT NOT NULL, created_at TEXT NOT NULL,
      last_synced_at TEXT)`);

    await addSyncOutboxTable(db);
    await addSyncOutboxTable(db);

    const columns = async (table: string) =>
      (await db.rawQuery(`PRAGMA table_info(${table})`)).map((c: any) => c.name);
    expect((await columns("note_links")).filter((c: string) => c === "client_uuid")).toHaveLength(1);
    expect(await columns("sync_outbox")).toContain("client_uuid");
    expect(await columns("server_capabilities")).toContain("fields_json");
  });
});
