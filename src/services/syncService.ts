import { DatabaseService, NoteLink, NoteLinkKind, OutboxOp } from "./databaseService";
import { OutboxBlockedError, OutboxRetryLaterError, OutboxService } from "./outboxService";
import { CapabilityService } from "./odoo/capabilityService";
import { PROJECT_MODEL, ProjectService } from "./odoo/projectService";
import { PARTNER_MODEL, RecordSearchService } from "./odoo/recordSearchService";
import { ACTIVITY_TYPE_MODEL, ActivityTypeService } from "./odoo/activityTypeService";
import { unusableReason } from "./odoo/capabilityService";
import { InvoiceFormService } from "./odoo/invoiceForm";
import { ActivityCalendarService } from "./activityCalendarService";
import { Application } from "../models/application";
import {
  Note,
  NoteEntry,
  NoteEntryGeolocationParams,
  NoteEntryTextParams,
  NoteEntryDateParams,
} from "../models/note";
import { syncConfigIdFor } from "../models/syncConfig";
import {
  OdooRpcClient,
  OdooRpcError,
  RemoteRecordDeletedError,
  StoredSession,
  SyncCredentials,
} from "./odoo/odooRpcClient";
import { v4 as uuidv4 } from "uuid";

export {
  OdooRpcError,
  RemoteRecordDeletedError,
  SessionExpiredError,
  syncSessionKey,
} from "./odoo/odooRpcClient";
export type { SyncCredentials } from "./odoo/odooRpcClient";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SyncResult {
  pushed: number;
  pulled: number;
  errors: string[];
}

/** Remote model a note is mirrored to by pushNote / pullNotes. */
const TASK_MODEL = "project.task";

/**
 * Minimum time between sending a task create and a retry that searches
 * its marker: longer than the HTTP read timeout plus Odoo's
 * default limit_time_real (120 s), so a create still running on the server
 * has committed — or been killed — before the search.
 */
const CREATE_QUIET_WINDOW_MS = 3 * 60 * 1000;

/** Tasks an ambiguous marker search lists for the user to pick from. */
const AMBIGUOUS_CANDIDATES_SHOWN = 5;

/** Outbox kind of the creation of a note's task on one server. */
export const TASK_CREATE = "task.create";

/** Outbox kind of the creation of a note's opportunity on one server. */
export const LEAD_CREATE = "lead.create";

/** Kinds of record a note can be sent as, in push order. */
export type TargetKind = "task" | "lead" | "invoice";
export const TARGET_KINDS: TargetKind[] = ["task", "lead", "invoice"];

/** Outbox kind of the creation of a note's draft invoice on one server. */
export const INVOICE_CREATE = "invoice.create";

/** Model of a note's draft invoice. */
export const INVOICE_MODEL = "account.move";

/** Invoice types a note can be drafted as: customer invoice, vendor bill. */
export type InvoiceMoveType = "out_invoice" | "in_invoice";

/** sync_target_prefs kind of the target kinds last checked per server. */
const TARGET_KINDS_PREF = "targets";

/** Model of a note's opportunity. */
const LEAD_MODEL = "crm.lead";

/** Outbox kind of the creation of one of a note's activities on one server. */
export const ACTIVITY_CREATE = "activity.create";

/** Model of a note's activities, and of the users one is assigned to. */
export const ACTIVITY_MODEL = "mail.activity";
export const USER_MODEL = "res.users";

/** Outbox kind of one of a note's messages posted in a record's chatter. */
export const MESSAGE_POST = "message.post";

/** Model of a posted message. */
const MESSAGE_MODEL = "mail.message";

/**
 * What a note can attach to a record it did not create, several per
 * server: an activity scheduled on it, or a message posted in its chatter.
 * Each is a note_links row of that kind once on the server.
 */
export type AttachedKind = "activity" | "message";
export const ATTACHED_KINDS: AttachedKind[] = ["activity", "message"];

/** The outbox kind of each attached kind's creation, and the text of one waiting for its record. */
const ATTACHED: Record<AttachedKind, { opKind: string; waitingChoice: string }> = {
  activity: { opKind: ACTIVITY_CREATE, waitingChoice: "L'activité attend le choix de son enregistrement" },
  message: { opKind: MESSAGE_POST, waitingChoice: "Le message attend le choix de son enregistrement" },
};

function isAttachedKind(kind: string): kind is AttachedKind {
  return (ATTACHED_KINDS as string[]).includes(kind);
}

/**
 * What the message edit route answers for a message that is gone, or no
 * longer the user's to edit: the link turns deleted.
 */
const MESSAGE_GONE_ERRORS = new Set(["werkzeug.exceptions.NotFound", "odoo.exceptions.MissingError"]);

/**
 * What a kind of target is on the server: its model, its creation's outbox
 * kind, its tag model (null: tags not mapped), the field its marker is
 * written in, the params a choice sets (choiceKeys), and the French texts
 * naming one record and a creation waiting for a choice.
 */
interface TargetKindDef {
  model: string;
  opKind: string;
  tagModel: string | null;
  markerField: string;
  choiceKeys: string[];
  describe: (resId: number) => string;
  waitingChoice: string;
}

export const KINDS: Record<TargetKind, TargetKindDef> = {
  task: {
    model: "project.task",
    opKind: TASK_CREATE,
    tagModel: "project.tags",
    markerField: "description",
    choiceKeys: ["projectId"],
    describe: (id) => `La tâche #${id}`,
    waitingChoice: "La tâche attend le choix de son projet",
  },
  lead: {
    model: LEAD_MODEL,
    opKind: LEAD_CREATE,
    tagModel: "crm.tag",
    markerField: "description",
    choiceKeys: ["partnerId", "expectedRevenue"],
    describe: (id) => `L'opportunité #${id}`,
    waitingChoice: "L'opportunité attend le choix de son client",
  },
  invoice: {
    model: INVOICE_MODEL,
    opKind: INVOICE_CREATE,
    tagModel: null,
    markerField: "narration",
    choiceKeys: ["moveType"],
    describe: (id) => `La facture #${id}`,
    waitingChoice: "La facture attend ses champs",
  },
};

/**
 * Where a note's task is created on one server: in projectId, or, when
 * null, as a personal task (no project). Chosen once, at creation; later
 * writes leave the task's project alone.
 */
export interface TaskTarget {
  projectId: number | null;
  projectName?: string | null;
}

/**
 * The values a note's opportunity is created with on one server: its
 * client (res.partner, null for none) and expected revenue (null: none).
 * Set at creation only; later writes leave them to the server.
 */
export interface LeadTarget {
  partnerId: number | null;
  partnerName?: string | null;
  expectedRevenue?: number | null;
}

/** One line of a draft invoice: its label, quantity, unit price (null: the product's) and optional product. */
export interface InvoiceLine {
  name: string;
  quantity: number;
  priceUnit: number | null;
  productId: number | null;
  productName?: string | null;
}

/**
 * The values a note's draft invoice is created with on one server: its
 * type, partner (null: none yet, allowed on a draft), date (null: the
 * server's), reference, lines, the server's other required fields the
 * user filled (extra, by field name, as sent), and the note's own record
 * of kind linkKind it is tied to (null: none). Set at creation only;
 * later writes send the note's text as the invoice's narration.
 */
export interface InvoiceTarget {
  moveType: InvoiceMoveType;
  partnerId: number | null;
  partnerName?: string | null;
  invoiceDate: string | null;
  ref: string | null;
  lines: InvoiceLine[];
  extra: Record<string, any>;
  /** Display names of the many2one values in extra, for the picker. */
  extraNames?: Record<string, string>;
  linkKind: "task" | "lead" | null;
}

export type Target = TaskTarget | LeadTarget | InvoiceTarget;

/**
 * One activity a note schedules on one server: on record resId of
 * resModel (null: not chosen yet, the creation waits as "incomplete"), of
 * type typeId, due on deadline ("YYYY-MM-DD"), assigned to userId; a null
 * type, deadline or user leaves the server's default (its default type,
 * today, the connected user). The names are kept for display offline.
 * Set at creation only: later writes send the note's title and text.
 */
export interface ActivityTarget {
  resModel: string;
  resId: number | null;
  resName?: string | null;
  typeId: number | null;
  typeName?: string | null;
  deadline: string | null;
  userId: number | null;
  userName?: string | null;
}

/**
 * Where one of a note's activities or messages (kind) stands on one
 * server; a message's target has only its record:
 * - linked: it exists; a push writes it, or marks an activity done when
 *   the note is done;
 * - done / deleted: an activity marked done by the app, or gone on the
 *   server (done, cancelled or deleted there); kept as history, never
 *   written;
 * - queued: its creation is in the outbox, due, retrying or blocked for a
 *   reason the next tap settles (ambiguous);
 * - choose: its creation waits for a choice: incomplete (no record yet),
 *   or blocked for a reason in CHOOSE_AGAIN_REASONS.
 */
export type AttachedState =
  | { kind: AttachedKind; state: "linked" | "done" | "deleted"; link: NoteLink; target: ActivityTarget }
  | { kind: AttachedKind; state: "queued"; op: OutboxOp; target: ActivityTarget }
  | { kind: AttachedKind; state: "choose"; op: OutboxOp; reason: string; target: ActivityTarget };

/** An activity's AttachedState. */
export type ActivityState = AttachedState;

export interface PushOptions {
  recreateDeleted?: boolean;
  /**
   * A tap on sync: a blocked creation runs again, and an incomplete one or
   * a deleted record is reported. Without it (background sync), a kind
   * whose creation is not due (see OutboxService.isDue) is skipped, and a
   * deleted record next to a live one is left alone.
   */
  userInitiated?: boolean;
  /** Background only: a creation in its retry delay counts as due. */
  force?: boolean;
  /** Push this kind only (an outbox handler runs its own operation). */
  onlyKind?: TargetKind;
  /** Run this activity or message creation only (its outbox handler). */
  onlyAttachedOp?: string;
  /**
   * Settles an "ambiguous" creation with the record picked: the creation
   * of a kind, or the activity or message creation opId.
   */
  adopt?: { kind: TargetKind | AttachedKind; resId: number; opId?: string };
  /** adopt for the note's task. */
  adoptTaskId?: number;
}

/**
 * Why a creation waits for the user to choose again: the project,
 * partner, record, activity type or user it names is gone or hidden from
 * the user, the model of an activity's record takes no activities
 * (model_unusable), or the server refused the creation (refused: rights,
 * a constraint).
 */
const CHOOSE_AGAIN_REASONS = new Set([
  "project_missing", "partner_missing", "record_missing", "type_missing", "user_missing", "model_unusable", "refused",
]);

/** Server exceptions a create retry cannot get past: the operation blocks. */
const REFUSED_ERRORS = new Set([
  "odoo.exceptions.AccessError",
  "odoo.exceptions.ValidationError",
  "odoo.exceptions.UserError",
  "odoo.exceptions.MissingError",
]);

/**
 * What a note needs before its record of one kind can reach one server:
 * - linked: the record exists; a push writes it;
 * - queued: its creation is in the outbox, due, retrying or blocked for a
 *   reason the user settles on the next tap (ambiguous);
 * - choose: the choice must be made first. op is the creation waiting
 *   for it (incomplete, or blocked for a reason in CHOOSE_AGAIN_REASONS),
 *   or null when nothing was ever chosen; reason "deleted" (with
 *   deletedResId) when the linked record was deleted on the server and
 *   choosing recreates it; target is the choice to offer first: the
 *   operation's, else the server's last.
 */
export type TargetState =
  | { state: "linked"; resId: number }
  | { state: "queued"; op: OutboxOp }
  | {
      state: "choose";
      op: OutboxOp | null;
      reason: string | null;
      target: Target | null;
      deletedResId?: number;
    };

/** TargetState of a note's task. */
export type TaskTargetState = TargetState;

/**
 * Text the app writes in a record it creates, searched to find that record
 * again when the answer to create() was lost.
 */
export function clientMarker(clientUuid: string): string {
  return `erplibre-mobile:${clientUuid}`;
}

/** project.task.state of a closed task (Odoo 17+). */
const TASK_STATE_DONE = "1_done";

/** Tasks per pull page, and pages per pull (bounds one pull to 5000 tasks). */
const PULL_PAGE_SIZE = 100;
const PULL_MAX_PAGES = 50;

/**
 * search_read context of pull and poll: archived tasks are returned too,
 * otherwise archiving a task on the server never reaches the note.
 */
const WITH_ARCHIVED = { active_test: false };

/**
 * First pull of a config (no cursor yet) starts this long before the
 * oldest link's last sync: that time comes from the device clock, task
 * write_dates from the server clock. Re-reading a task is harmless.
 */
const FIRST_PULL_CLOCK_MARGIN_MS = 24 * 60 * 60 * 1000;

/**
 * Order in which a push raises the failures of a note's kinds, most
 * urgent for the user first: a creation to settle by hand (ambiguous),
 * then any other error, then a creation waiting for a choice, then a
 * record deleted on the server.
 */
function failureRank(e: unknown): number {
  if (e instanceof OutboxBlockedError && e.reason === "ambiguous") return 0;
  if (e instanceof RemoteRecordDeletedError) return 3;
  if (e instanceof OutboxBlockedError && e.reason === "incomplete") return 2;
  return 1;
}

/** "YYYY-MM-DD" of an ISO date-time in the device's time zone, or null. */
export function localDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Creation params of a kind's target (null: no project, no partner). */
function targetParams(kind: TargetKind, target: Target | null): Record<string, any> {
  if (kind === "task") {
    const t = target as TaskTarget | null;
    return { projectId: t?.projectId ?? null, projectName: t?.projectName ?? null };
  }
  if (kind === "invoice") {
    const t = target as InvoiceTarget | null;
    if (!t) return {};
    return {
      moveType: t.moveType, partnerId: t.partnerId ?? null, partnerName: t.partnerName ?? null,
      invoiceDate: t.invoiceDate ?? null, ref: t.ref ?? null, lines: t.lines ?? [], extra: t.extra ?? {},
      extraNames: t.extraNames ?? {}, linkKind: t.linkKind ?? null,
    };
  }
  const t = target as LeadTarget | null;
  return {
    partnerId: t?.partnerId ?? null,
    partnerName: t?.partnerName ?? null,
    expectedRevenue: t?.expectedRevenue ?? null,
  };
}

/** The target stored in a creation's params. */
function targetOfParams(kind: TargetKind, params: Record<string, any>): Target {
  if (kind === "task") return { projectId: params.projectId ?? null, projectName: params.projectName ?? null };
  if (kind === "invoice") {
    return {
      moveType: params.moveType === "in_invoice" ? "in_invoice" : "out_invoice",
      partnerId: params.partnerId ?? null, partnerName: params.partnerName ?? null,
      invoiceDate: params.invoiceDate ?? null, ref: params.ref ?? null,
      lines: params.lines ?? [], extra: params.extra ?? {}, extraNames: params.extraNames ?? {},
      linkKind: params.linkKind ?? null,
    };
  }
  return {
    partnerId: params.partnerId ?? null,
    partnerName: params.partnerName ?? null,
    expectedRevenue: params.expectedRevenue ?? null,
  };
}

/**
 * Values only a create sends, from the operation's params: a task's
 * project (false: none); a lead's type, partner, expected revenue and
 * archive state; an invoice's type, partner, date, reference, lines
 * (product, label, quantity, unit price) and the other fields the user
 * filled.
 */
function createValues(kind: TargetKind, params: Record<string, any>, note: Note): Record<string, any> {
  if (kind === "task") return { project_id: params.projectId ?? false };
  if (kind === "invoice") {
    const t = targetOfParams("invoice", params) as InvoiceTarget;
    return {
      ...t.extra,
      move_type: t.moveType,
      ...(t.partnerId != null ? { partner_id: t.partnerId } : {}),
      ...(t.invoiceDate ? { invoice_date: t.invoiceDate } : {}),
      ...(t.ref ? { ref: t.ref } : {}),
      invoice_line_ids: t.lines.map((l) => [0, 0, {
        name: l.name,
        quantity: l.quantity,
        // No price typed: the server computes the product's own
        ...(l.priceUnit != null ? { price_unit: l.priceUnit } : {}),
        ...(l.productId != null ? { product_id: l.productId } : {}),
      }]),
    };
  }
  return {
    type: "opportunity",
    active: !note.archived,
    ...(params.partnerId != null ? { partner_id: params.partnerId } : {}),
    ...(params.expectedRevenue != null ? { expected_revenue: params.expectedRevenue } : {}),
  };
}

/** Creation params of an activity target. */
function activityParams(target: ActivityTarget): Record<string, any> {
  return {
    resModel: target.resModel,
    resId: target.resId ?? null,
    resName: target.resName ?? null,
    typeId: target.typeId ?? null,
    typeName: target.typeName ?? null,
    deadline: target.deadline ?? null,
    userId: target.userId ?? null,
    userName: target.userName ?? null,
  };
}

/** The activity target stored in a creation's or a link's params. */
function activityOfParams(params: Record<string, any>): ActivityTarget {
  return {
    resModel: params.resModel ?? "",
    resId: params.resId ?? null,
    resName: params.resName ?? null,
    typeId: params.typeId ?? null,
    typeName: params.typeName ?? null,
    deadline: params.deadline ?? null,
    userId: params.userId ?? null,
    userName: params.userName ?? null,
  };
}

/**
 * How createWithMarker creates one record: its model and outbox kind, the
 * field its marker is written in and searched by (within markerScope, a
 * domain, when given), the values every write sends (marker included) and
 * those only create adds, the context of the create, the checks of the
 * records it names, and the link it leaves. create and write replace the
 * model's own create() and write() (a message is posted on its record and
 * edited through a route); sentParams gives, from the values sent, params
 * stored on the operation before the create and on the link after it: a
 * record found again by its marker whose sentParams still match what the
 * operation sent is linked without being written again.
 */
interface CreateSpec {
  model: string;
  opKind: string;
  markerField: string;
  markerScope?: any[];
  values: (sessionId: string, odooVersion: number, note: Note) => Promise<Record<string, any>>;
  createValues: (note: Note) => Record<string, any>;
  context?: Record<string, any>;
  create?: (sessionId: string, odooVersion: number, values: Record<string, any>) => Promise<number>;
  write?: (sessionId: string, resId: number, values: Record<string, any>) => Promise<void>;
  check: (sessionId: string) => Promise<void>;
  link: { kind: NoteLinkKind; params?: Record<string, any> };
  sentParams?: (values: Record<string, any>) => Record<string, any>;
  /** Server exceptions that also refuse this create, beside REFUSED_ERRORS. */
  refusedErrors?: string[];
  /**
   * Runs once the record is created, or found again by its marker or
   * adopted (adopted: true, the first attempt may have run it already);
   * its result joins the link's params.
   */
  afterCreate?: (sessionId: string, odooVersion: number, resId: number, adopted: boolean) => Promise<Record<string, any>>;
}

/**
 * message_post kwargs of a note's message: a logged note (mt_note, the
 * only kind the edit route accepts on 16), HTML kept on 17+ by
 * body_is_html, which 16 does not know (it sanitizes the string as HTML).
 */
function messagePostKwargs(body: string, odooVersion: number): Record<string, any> {
  return {
    body,
    ...(odooVersion >= 17 ? { body_is_html: true } : {}),
    message_type: "comment",
    subtype_xmlid: "mail.mt_note",
  };
}

/** A short hash of a text (FNV-1a, 32 bits), to tell whether it changed. */
function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** A record a creation names, looked up before the create (see checkChosen). */
interface ChosenRecordCheck {
  model: string;
  id: number | null;
  reason: string;
  label: string;
  context?: Record<string, any>;
}

/** Fields of a note a push sends: a change here during a push re-queues it. */
function pushedFingerprint(note: Note): string {
  return JSON.stringify([note.title, note.done, note.archived, note.pinned, note.tags, note.entries]);
}

/** Sync config id of a set of credentials, as built by appToSyncConfig. */
export function syncConfigIdOf(creds: SyncCredentials): string {
  return syncConfigIdFor(creds.odooUrl, creds.username, creds.database);
}

// ─── SyncService ──────────────────────────────────────────────────────────────

export class SyncService {
  private db: DatabaseService;
  /** JSON-RPC transport and session store, shared with the other Odoo services. */
  readonly rpc: OdooRpcClient;
  /** Pending creations and one-shot operations, per note and server. */
  readonly outbox: OutboxService;
  /** Cached probes of what each server allows per model. */
  readonly capabilities: CapabilityService;
  /** Projects a new task can go to, per server, cached for offline. */
  readonly projects: ProjectService;
  /** Partner search for a new opportunity, with the found ones cached. */
  readonly partners: RecordSearchService;
  /** The extra required fields of a new invoice per server and type, kept for offline. */
  readonly invoiceForms: InvoiceFormService;
  /** The activity calendar: activities per server, cached, and its offline actions. */
  readonly calendar: ActivityCalendarService;
  /** Activity types per server, cached for offline. */
  readonly activityTypes: ActivityTypeService;
  /** Record search per model (records an activity goes on, users), cached. */
  private _recordSearches = new Map<string, RecordSearchService>();
  /**
   * Whether project.task has geo_task_point, per "url|database". The field
   * comes from an optional server module; sending it where it is missing
   * makes create/write fail. Probed once per server for the app's lifetime.
   */
  private _taskGeoField = new Map<string, boolean>();
  /**
   * In-flight pushNote per "note|config id". A second push of the
   * same note to the same server waits for the first, so a note never yet
   * linked is created once, not once per concurrent caller (reconnect
   * syncAll racing a tap on the sync button).
   */
  private _pushInFlight = new Map<string, Promise<void>>();
  /**
   * Tail of the syncAll runs per config id: a reconnect and a return to
   * the foreground firing together run one after the other.
   */
  private _syncAllChain = new Map<string, Promise<unknown>>();
  /**
   * Called with the id of each note a pull changed, so a screen showing
   * that note reloads it instead of saving its older copy over it.
   */
  onNotePulled: ((noteId: string) => void) | null = null;

  constructor(
    db: DatabaseService,
    rpc: OdooRpcClient = new OdooRpcClient(),
    outbox: OutboxService = new OutboxService(db)
  ) {
    this.db = db;
    this.rpc = rpc;
    this.outbox = outbox;
    this.capabilities = new CapabilityService(db, rpc);
    this.projects = new ProjectService(db, rpc);
    this.invoiceForms = new InvoiceFormService(db, rpc);
    this.partners = new RecordSearchService(db, rpc, PARTNER_MODEL);
    this._recordSearches.set(PARTNER_MODEL, this.partners);
    this.activityTypes = new ActivityTypeService(db, rpc);
    this.calendar = new ActivityCalendarService(db, rpc, outbox);
    this.outbox.onRetryScheduled = (at) => this.onRetryScheduled?.(at);
    for (const kind of TARGET_KINDS) {
      // drain already found the operation due: its retry delay is over or forced
      this.outbox.registerHandler(KINDS[kind].opKind, (creds, op) =>
        this.pushNote(creds, op.noteId, { onlyKind: kind, force: true }));
    }
    for (const kind of ATTACHED_KINDS) {
      this.outbox.registerHandler(ATTACHED[kind].opKind, (creds, op) =>
        this.pushNote(creds, op.noteId, { onlyAttachedOp: op.id, force: true }));
    }
  }

  /** Name search of model's records on a server, with the ones found cached. */
  recordSearch(model: string): RecordSearchService {
    let search = this._recordSearches.get(model);
    if (!search) {
      search = new RecordSearchService(this.db, this.rpc, model);
      this._recordSearches.set(model, search);
    }
    return search;
  }

  // ─── Transport (OdooRpcClient) ────────────────────────────────────────────

  /** Logs in and stores the session; see OdooRpcClient.authenticate. */
  authenticate(creds: SyncCredentials): Promise<StoredSession> {
    return this.rpc.authenticate(creds);
  }

  private callWithAuth<T>(
    creds: SyncCredentials,
    fn: (sessionId: string, odooVersion: number) => Promise<T>
  ): Promise<T> {
    return this.rpc.callWithAuth(creds, fn);
  }

  private jsonRpc(
    odooUrl: string,
    sessionId: string,
    model: string,
    method: string,
    args: any[],
    kwargs: Record<string, any> = {}
  ): Promise<any> {
    return this.rpc.jsonRpc(odooUrl, sessionId, model, method, args, kwargs);
  }

  // ─── Tag resolution ───────────────────────────────────────────────────────

  /**
   * Finds or creates tags of model (project.tags, crm.tag) by name and
   * returns their Odoo integer IDs.
   */
  private async resolveTags(
    creds: SyncCredentials,
    sessionId: string,
    tagNames: string[],
    model = "project.tags"
  ): Promise<number[]> {
    if (tagNames.length === 0) return [];

    const existing: { id: number; name: string }[] = await this.jsonRpc(
      creds.odooUrl, sessionId, model, "search_read",
      [],
      { domain: [["name", "in", tagNames]], fields: ["id", "name"] }
    );

    const existingByName = new Map(existing.map((t) => [t.name, t.id]));
    const ids: number[] = [];

    for (const name of tagNames) {
      if (existingByName.has(name)) {
        ids.push(existingByName.get(name)!);
      } else {
        const newId: number = await this.jsonRpc(
          creds.odooUrl, sessionId, model, "create",
          [{ name }]
        );
        ids.push(newId);
      }
    }
    return ids;
  }

  // ─── HTML builder ─────────────────────────────────────────────────────────

  /**
   * Converts note entries to an HTML description for Odoo.
   * Each entry becomes one or more <p> tags.
   */
  buildHtml(entries: NoteEntry[]): string {
    const parts: string[] = [];
    for (const entry of entries) {
      switch (entry.type) {
        case "text": {
          const p = entry.params as NoteEntryTextParams;
          if (p.text.trim()) parts.push(`<p>${this.escapeHtml(p.text)}</p>`);
          break;
        }
        case "date": {
          const p = entry.params as NoteEntryDateParams;
          parts.push(`<p>📅 Date : ${p.date}</p>`);
          break;
        }
        case "geolocation": {
          const p = entry.params as NoteEntryGeolocationParams;
          const ts = new Date(p.timestamp).toISOString();
          parts.push(`<p>📍 Géolocalisation : ${p.latitude}, ${p.longitude} — ${this.escapeHtml(p.text)} — ${ts}</p>`);
          break;
        }
        // No time: the entries store none, and the HTML of an unchanged
        // note must stay the same from one push to the next
        case "audio":
          parts.push("<p>🎙️ Enregistrement audio</p>");
          break;
        case "photo":
          parts.push("<p>📷 Photo</p>");
          break;
        case "video":
          parts.push("<p>🎥 Vidéo</p>");
          break;
      }
    }
    return parts.join("\n");
  }

  /**
   * Builds a GeoJSON MultiPoint string from all geolocation entries.
   * Returns null if there are no geolocation entries.
   * Coordinates are [longitude, latitude] per GeoJSON spec.
   */
  buildGeoMultiPoint(entries: NoteEntry[]): string | null {
    const geoEntries = entries.filter((e) => e.type === "geolocation");
    if (geoEntries.length === 0) return null;

    const coordinates = geoEntries.map((e) => {
      const p = e.params as NoteEntryGeolocationParams;
      return [p.longitude, p.latitude];
    });

    return JSON.stringify({ type: "MultiPoint", coordinates });
  }

  /**
   * Returns the first date entry's ISO string, or null.
   */
  private getFirstDate(entries: NoteEntry[]): string | null {
    const dateEntry = entries.find((e) => e.type === "date");
    if (!dateEntry) return null;
    return (dateEntry.params as NoteEntryDateParams).date;
  }

  // ─── Push ─────────────────────────────────────────────────────────────────

  /**
   * Pushes a single note to one server, to each of its targets there (see
   * noteKinds): write() on the record the note is linked to for that kind,
   * or, without one, the creation as the kind's outbox operation (see
   * createRecord). Every kind is tried, then the failure that most needs
   * the user is raised (see failureRank). The note's fingerprint is taken
   * once, before the first kind: each success marks the server "synced",
   * or "pending" when the note changed since then — the server got the
   * older content for some kind — and the global status is re-derived.
   *
   * A link whose record was deleted on the server is never recreated
   * silently: write() answering MissingError marks the link deleted and
   * raises RemoteRecordDeletedError; so does a later tap while only that
   * deleted link exists for the kind, unless options.recreateDeleted asks
   * for a new record or a creation for it is already queued (a recreate
   * the user confirmed). The server leaves the note's queue only when no
   * other kind of the note is live there; a background push next to a
   * live kind skips the deleted one silently.
   *
   * A creation the outbox holds "blocked" waits for the user: a
   * background push skips it without contacting the server, and
   * options.userInitiated (a tap on sync) runs it again. options.adopt
   * (adoptTaskId: a task) settles an "ambiguous" creation with the record
   * the user picked among the error's candidates. An "incomplete" creation
   * never runs, tap or not: its choice is made first (setTarget). A task
   * creation queued here, with no choice made, goes to the server's last
   * chosen project (see setTarget), else is a personal task.
   */
  async pushNote(creds: SyncCredentials, noteId: string, options: PushOptions = {}): Promise<void> {
    const key = `${noteId}|${syncConfigIdOf(creds)}`;
    const previous = this._pushInFlight.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.pushNoteNow(creds, noteId, options));
    this._pushInFlight.set(key, current);
    try {
      await current;
    } finally {
      if (this._pushInFlight.get(key) === current) this._pushInFlight.delete(key);
    }
  }

  private async pushNoteNow(creds: SyncCredentials, noteId: string, options: PushOptions): Promise<void> {
    const note = await this.db.getNoteById(noteId);
    if (!note) throw new Error(`Note ${noteId} not found`);
    const fingerprint = pushedFingerprint(note);
    const configId = syncConfigIdOf(creds);
    const kinds = options.onlyKind ? [options.onlyKind]
      : options.onlyAttachedOp ? []
      : await this.noteKinds(noteId, configId);
    let failure: unknown = null;
    const keep = (e: unknown) => {
      if (failure === null || failureRank(e) < failureRank(failure)) failure = e;
    };
    for (const kind of kinds) {
      try {
        await this.pushKind(creds, noteId, kind, options, fingerprint);
      } catch (e: unknown) {
        keep(e);
      }
    }
    if (!options.onlyKind) await this.pushAttached(creds, noteId, options, fingerprint, keep);
    if (failure !== null) throw failure;
  }

  /**
   * The kinds of target a note has on one server: those with a link
   * (live or deleted, not dismissed) or a creation in the outbox, in
   * TARGET_KINDS order. A note with none there gets a task, as before
   * targets had kinds, unless it has activities or messages there (any
   * link or creation): then it has none.
   */
  async noteKinds(noteId: string, configId: string): Promise<TargetKind[]> {
    const links = (await this.db.getNoteLinks(noteId))
      .filter((l) => l.configId === configId && l.remoteState !== "dismissed");
    const ops = (await this.db.getOutboxOpsForNote(noteId)).filter((op) => op.configId === configId);
    const kinds = TARGET_KINDS.filter((kind) =>
      links.some((l) => l.kind === "create" && l.model === KINDS[kind].model)
        || ops.some((op) => op.kind === KINDS[kind].opKind)
    );
    if (kinds.length > 0) return kinds;
    const attached = links.some((l) => isAttachedKind(l.kind))
      || ops.some((op) => ATTACHED_KINDS.some((k) => ATTACHED[k].opKind === op.kind));
    return attached ? [] : ["task"];
  }

  /**
   * Whether the note has a live link on this server other than those
   * except matches: then a record of theirs deleted on the server does
   * not take the server out of the note's queue.
   */
  private async hasOtherLiveLink(noteId: string, configId: string, except: (l: NoteLink) => boolean): Promise<boolean> {
    return (await this.db.getNoteLinks(noteId)).some((l) =>
      l.configId === configId && l.remoteState === "ok" && !except(l));
  }

  /** hasOtherLiveLink beside the note's record of kind: another kind, an activity or a message. */
  private async hasOtherLiveKind(noteId: string, configId: string, kind: TargetKind): Promise<boolean> {
    return this.hasOtherLiveLink(noteId, configId, (l) => l.kind === "create" && l.model === KINDS[kind].model);
  }

  /** One kind of pushNoteNow: write the linked record, or run its creation. */
  private async pushKind(
    creds: SyncCredentials,
    noteId: string,
    kind: TargetKind,
    options: PushOptions,
    fingerprint: string
  ): Promise<void> {
    const def = KINDS[kind];
    const note = await this.db.getNoteById(noteId);
    if (!note) return;

    const configId = syncConfigIdOf(creds);
    const known = await this.db.findNoteLink(noteId, configId, def.model, "create", true);
    const link = known?.remoteState === "ok" ? known : null;

    if (!link) {
      const queued = await this.outbox.find(noteId, configId, def.opKind);
      if (known && !options.recreateDeleted && !queued) {
        if (await this.hasOtherLiveKind(noteId, configId, kind)) {
          if (!options.userInitiated) return;
        } else {
          await this.db.clearNotePerServerStatus(noteId, configId);
          await this.db.refreshNoteSyncStatus(noteId);
        }
        throw new RemoteRecordDeletedError(`${def.describe(known.resId)} a été supprimée sur ${creds.odooUrl}.`);
      }
      // Background: a creation waiting for the user, or for its delay, is left for later
      if (queued && !options.userInitiated && !this.outbox.isDue(queued, options.force)) return;
      if (queued?.status === "incomplete") {
        throw new OutboxBlockedError(`${def.waitingChoice} sur ${creds.odooUrl}.`, "incomplete", [], def.opKind);
      }
      // An invoice tied to the note's task or opportunity waits for its creation
      if (queued && await this.tieWaiting(queued)) {
        if (!options.userInitiated) return;
        throw new OutboxBlockedError(
          `La facture attend la création de ${queued.params.linkKind === "task" ? "sa tâche" : "son opportunité"} sur ${creds.odooUrl}.`,
          "incomplete", [], def.opKind
        );
      }
      if (queued?.status === "blocked" && !options.userInitiated) {
        throw new OutboxBlockedError(
          queued.lastError ?? queued.status,
          queued.params.blockedReason ?? queued.status,
          queued.params.candidates ?? [],
          def.opKind
        );
      }
      const op = queued ?? await this.outbox.enqueue({
        noteId, configId, kind: def.opKind, params: targetParams(kind, await this.lastTarget(configId, kind)),
      });
      const adopt = options.adopt?.kind === kind ? options.adopt.resId
        : kind === "task" ? options.adoptTaskId ?? null : null;
      await this.outbox.attempt(op.id, (running) => this.createRecord(kind, creds, running, adopt, fingerprint));
      // The row is deleted only once the attempt settled: derive the status without it
      await this.db.refreshNoteSyncStatus(noteId);
      return;
    }
    // A creation that linked its record but was cut short before its row
    // was deleted: the link is the outcome, the row is obsolete.
    const stale = await this.outbox.find(noteId, configId, def.opKind);
    if (stale) await this.outbox.cancel(stale.id);

    await this.callWithAuth(creds, async (sessionId, odooVersion) => {
      const payload = await this.payloadFor(kind, creds, sessionId, note, odooVersion, link.clientUuid ?? null);
      try {
        await this.jsonRpc(creds.odooUrl, sessionId, def.model, "write", [[link.resId], payload]);
      } catch (e: unknown) {
        if (!(e instanceof OdooRpcError) || e.odooName !== "odoo.exceptions.MissingError") throw e;
        await this.db.setNoteLinkRemoteDeleted(link.id);
        if (!(await this.hasOtherLiveKind(noteId, configId, kind))) {
          await this.db.clearNotePerServerStatus(noteId, configId);
        }
        await this.db.refreshNoteSyncStatus(noteId);
        throw new RemoteRecordDeletedError(`${def.describe(link.resId)} a été supprimée sur ${creds.odooUrl}.`);
      }
      const now = new Date().toISOString();
      await this.db.setNoteLinkSyncedAt(link.id, now);
      await this.settlePush(noteId, configId, fingerprint, now, null);
    });
  }

  /**
   * The creation operation of one kind for a note on one server: creates
   * the record carrying the operation's client_uuid marker and links it.
   *
   * On a retry (attempts > 1) an earlier run may have created the record
   * and lost the answer, so the marker is searched first, archived records
   * included: one match is adopted (written with the current content),
   * none means create, and several block the operation as "ambiguous"
   * with the matching ids as candidates — which record is the note's is
   * the user's call, answered through adoptId. A copy made on the server
   * (duplicate, project copy) carries the marker too, and archiving it
   * does not end the ambiguity.
   *
   * The search cannot see a create the server is still running (its
   * transaction is not committed). params.createSentAt, stored just before
   * each create() is sent, dates the last one: a retry within
   * CREATE_QUIET_WINDOW_MS of it raises OutboxRetryLaterError instead,
   * whatever triggered it (tap, reconnect, restart). A createSentAt later
   * than now (the clock was set back) is reset to now, so the window ends
   * three minutes after the correction, not after the clock's offset.
   *
   * The record gets the kind's chosen values (task: params.projectId,
   * null for no project; lead: params.partnerId and expectedRevenue).
   * Before a create, a chosen project or partner is looked up among the
   * active ones, as the picker lists them: gone, archived or hidden from
   * the user, the operation blocks as "project_missing" or
   * "partner_missing", and a project stops being the server's last
   * choice. A create the server refuses (REFUSED_ERRORS) blocks as
   * "refused", its createSentAt cleared since the server answered: a retry
   * would fail the same way. Either waits for the user to choose again.
   */
  private async createRecord(
    kind: TargetKind,
    creds: SyncCredentials,
    op: OutboxOp,
    adoptId: number | null,
    fingerprint: string
  ): Promise<void> {
    const def = KINDS[kind];
    const tie = kind === "invoice" ? await this.invoiceTie(creds, op) : null;
    await this.createWithMarker(creds, op, adoptId, fingerprint, {
      model: def.model,
      opKind: def.opKind,
      markerField: def.markerField,
      values: (sessionId, odooVersion, note) =>
        this.payloadFor(kind, creds, sessionId, note, odooVersion, op.clientUuid),
      createValues: (note) => ({
        ...createValues(kind, op.params, note),
        ...(tie?.field ? { [tie.field]: tie.resId } : {}),
      }),
      ...(kind === "invoice" ? { context: { default_move_type: op.params.moveType ?? "out_invoice" } } : {}),
      check: (sessionId) => this.checkChosenRecords(kind, creds, op, sessionId),
      link: { kind: "create" },
      ...(tie && !tie.field
        ? { afterCreate: (sessionId: string, odooVersion: number, resId: number, adopted: boolean) =>
            this.crossLinkInvoice(creds, sessionId, odooVersion, resId, tie, adopted) }
        : {}),
      // A malformed extra value is refused by the ORM's conversion
      ...(kind === "invoice" ? { refusedErrors: ["builtins.ValueError", "builtins.TypeError"] } : {}),
    });
  }

  /**
   * Whether an invoice creation must wait: it is tied (params.linkKind) to
   * the note's task or opportunity on this server, which is not linked yet
   * but has its creation in the outbox. Created first, the invoice would
   * lose its tie for good, the tie being set at creation only.
   */
  private async tieWaiting(op: OutboxOp): Promise<boolean> {
    if (op.kind !== INVOICE_CREATE) return false;
    const kind = op.params.linkKind === "task" || op.params.linkKind === "lead" ? op.params.linkKind as "task" | "lead" : null;
    if (!kind) return false;
    if (await this.db.findNoteLink(op.noteId, op.configId, KINDS[kind].model, "create")) return false;
    return (await this.outbox.find(op.noteId, op.configId, KINDS[kind].opKind)) !== null;
  }

  /**
   * The note's own record an invoice creation ties to (params.linkKind,
   * linked on this server), and how: through a many2one of account.move
   * to its model that the user can set (from the model's probe: not
   * readonly, not computed), which a module may add; null field when
   * there is none, the tie then being two cross messages (see
   * crossLinkInvoice). null when no tie is asked for, or the record is
   * not linked there (any more).
   */
  private async invoiceTie(
    creds: SyncCredentials,
    op: OutboxOp
  ): Promise<{ kind: "task" | "lead"; model: string; resId: number; field: string | null } | null> {
    const kind: "task" | "lead" | null = op.params.linkKind === "task" || op.params.linkKind === "lead"
      ? op.params.linkKind : null;
    if (!kind) return null;
    const link = await this.db.findNoteLink(op.noteId, op.configId, KINDS[kind].model, "create");
    if (!link) return null;
    const cap = await this.capabilities.ensure(creds, INVOICE_MODEL, { online: true });
    const field = Object.entries(cap?.fields ?? {}).find(([, f]) =>
      f.type === "many2one" && f.relation === KINDS[kind].model && !f.readonly && !(f.depends?.length))?.[0] ?? null;
    return { kind, model: KINDS[kind].model, resId: link.resId, field };
  }

  /**
   * Ties a new invoice to the note's task or opportunity with no field for
   * it: a logged note in each chatter linking to the other. An invoice
   * found again by its marker (adopted) gets each one only when the chatter
   * lacks it. Best effort, the invoice being created already: a failure is
   * kept in the link's params (crossError), not raised.
   */
  private async crossLinkInvoice(
    creds: SyncCredentials,
    sessionId: string,
    odooVersion: number,
    invoiceId: number,
    tie: { kind: "task" | "lead"; model: string; resId: number },
    adopted: boolean
  ): Promise<Record<string, any>> {
    const anchor = (model: string, id: number, label: string) =>
      `<a href="/web#model=${model}&amp;id=${id}" data-oe-model="${model}" data-oe-id="${id}">${label} #${id}</a>`;
    const what = tie.kind === "task" ? "la tâche" : "l'opportunité";
    // Each side is posted unless found already: an adopted invoice's first attempt may have posted it
    const posted = async (model: string, resId: number, otherModel: string, otherId: number) => adopted
      && (await this.jsonRpc(creds.odooUrl, sessionId, MESSAGE_MODEL, "search_count", [[
        ["model", "=", model], ["res_id", "=", resId], ["body", "ilike", `data-oe-model="${otherModel}" data-oe-id="${otherId}"`],
      ]])) > 0;
    try {
      if (!(await posted(INVOICE_MODEL, invoiceId, tie.model, tie.resId))) {
        await this.jsonRpc(creds.odooUrl, sessionId, INVOICE_MODEL, "message_post", [[invoiceId]],
          messagePostKwargs(`<p>Liée à ${anchor(tie.model, tie.resId, what)}.</p>`, odooVersion));
      }
      if (!(await posted(tie.model, tie.resId, INVOICE_MODEL, invoiceId))) {
        await this.jsonRpc(creds.odooUrl, sessionId, tie.model, "message_post", [[tie.resId]],
          messagePostKwargs(`<p>Facture brouillon ${anchor(INVOICE_MODEL, invoiceId, "facture")} créée depuis cette note.</p>`, odooVersion));
      }
      return { crossLinked: true };
    } catch (e: unknown) {
      return { crossLinked: false, crossError: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Creates the record of one outbox operation as spec says, with the
   * operation's client_uuid marker in spec.markerField, and links it: the
   * quiet window, marker search, adoption and refusal of createRecord.
   */
  private async createWithMarker(
    creds: SyncCredentials,
    op: OutboxOp,
    adoptId: number | null,
    fingerprint: string,
    spec: CreateSpec
  ): Promise<void> {
    const note = await this.db.getNoteById(op.noteId);
    if (!note) return;
    let createSentAt: string | undefined = op.params.createSentAt;
    if (createSentAt && new Date(createSentAt).getTime() > Date.now()) {
      // Stored under a clock that ran fast: the window restarts once, now
      createSentAt = new Date().toISOString();
      await this.outbox.setParams(op.id, { createSentAt });
    }
    if (adoptId === null && createSentAt) {
      const quietUntil = new Date(new Date(createSentAt).getTime() + CREATE_QUIET_WINDOW_MS);
      if (quietUntil.getTime() > Date.now()) {
        throw new OutboxRetryLaterError(
          `La création précédente peut encore être en cours sur ${creds.odooUrl} ; `
            + `nouvel essai après ${quietUntil.toLocaleTimeString()}.`,
          quietUntil.toISOString()
        );
      }
    }
    await this.callWithAuth(creds, async (sessionId, odooVersion) => {
      const payload = await spec.values(sessionId, odooVersion, note);
      let resId: number | null = adoptId;
      if (resId === null && op.attempts > 1) {
        const found: Array<{ id: number }> = await this.jsonRpc(
          creds.odooUrl, sessionId, spec.model, "search_read",
          [],
          {
            domain: [...(spec.markerScope ?? []), [spec.markerField, "ilike", clientMarker(op.clientUuid)]],
            fields: ["id"],
            limit: AMBIGUOUS_CANDIDATES_SHOWN,
            order: "id asc",
            context: WITH_ARCHIVED,
          }
        );
        if (found.length > 1) {
          throw new OutboxBlockedError(
            `Plusieurs enregistrements ${spec.model} (${found.map((t) => `#${t.id}`).join(", ")}) portent la référence `
              + `${clientMarker(op.clientUuid)} sur ${creds.odooUrl}.`,
            "ambiguous",
            found.map((t) => t.id),
            spec.opKind,
            op.id
          );
        }
        if (found.length === 1) resId = found[0].id;
      }
      const adopted = resId !== null;
      const sent = spec.sentParams?.(payload) ?? {};
      let after: Record<string, any> = {};
      const unchanged = !!spec.sentParams && Object.entries(sent).every(([k, v]) => op.params[k] === v);
      if (resId !== null) {
        if (unchanged) {
          // Found as it was sent: writing it would only mark it edited
        } else if (spec.write) await spec.write(sessionId, resId, payload);
        else await this.jsonRpc(creds.odooUrl, sessionId, spec.model, "write", [[resId], payload]);
      } else {
        await spec.check(sessionId);
        await this.outbox.setParams(op.id, { createSentAt: new Date().toISOString(), ...sent });
        try {
          const values = { ...payload, ...spec.createValues(note) };
          resId = spec.create
            ? await spec.create(sessionId, odooVersion, values)
            : await this.jsonRpc(
                creds.odooUrl, sessionId, spec.model, "create", [values],
                spec.context ? { context: spec.context } : {}
              );
        } catch (e: unknown) {
          const refused = e instanceof OdooRpcError && !!e.odooName
            && (REFUSED_ERRORS.has(e.odooName) || !!spec.refusedErrors?.includes(e.odooName));
          if (refused) {
            // The server answered and rolled back: no create is in flight
            await this.outbox.setParams(op.id, { createSentAt: null });
            throw new OutboxBlockedError(
              `Création refusée par ${creds.odooUrl} : ${(e as Error).message}`, "refused", [], spec.opKind, op.id
            );
          }
          throw e;
        }
        if (spec.afterCreate) after = await spec.afterCreate(sessionId, odooVersion, resId!, false);
      }
      if (adopted && spec.afterCreate) after = await spec.afterCreate(sessionId, odooVersion, resId!, true);
      const now = new Date().toISOString();
      await this.settlePush(op.noteId, op.configId, fingerprint, now, {
        id: uuidv4(),
        noteId: op.noteId,
        configId: op.configId,
        model: spec.model,
        resId: resId!,
        kind: spec.link.kind,
        remoteState: "ok",
        createdAt: now,
        lastSyncedAt: now,
        clientUuid: op.clientUuid,
        params: { ...(spec.link.params ?? {}), ...sent, ...after },
      });
    });
  }

  /**
   * Looks up, before a create, the project (task) or partner (lead) the
   * operation names: see createRecord. A project found missing stops being
   * the server's last choice.
   */
  private async checkChosenRecords(
    kind: TargetKind,
    creds: SyncCredentials,
    op: OutboxOp,
    sessionId: string
  ): Promise<void> {
    const check: ChosenRecordCheck = kind === "task"
      ? { model: PROJECT_MODEL, id: op.params.projectId ?? null, reason: "project_missing", label: "Le projet" }
      : { model: PARTNER_MODEL, id: op.params.partnerId ?? null, reason: "partner_missing", label: "Le partenaire" };
    await this.checkChosen(creds, sessionId, [check], KINDS[kind].opKind, op.id, async (failed) => {
      if (kind === "task" && (await this.lastTaskTarget(op.configId))?.projectId === failed.id) {
        await this.db.setSyncTargetPref({
          configId: op.configId, kind: TASK_CREATE, params: targetParams("task", null),
          updatedAt: new Date().toISOString(),
        });
      }
    });
  }

  /**
   * Looks up each named record (id null: none named, skipped) by id with
   * search_read, under its check's context (active ones only unless it
   * says otherwise). The first one not found — gone, archived, hidden by a
   * record rule, unreadable (AccessError) or of a model the server does not
   * have (KeyError) — runs onMissing, then blocks the operation with its
   * check's reason.
   */
  private async checkChosen(
    creds: SyncCredentials,
    sessionId: string,
    checks: ChosenRecordCheck[],
    opKind: string,
    opId: string,
    onMissing: (check: ChosenRecordCheck) => Promise<void> = async () => {}
  ): Promise<void> {
    for (const check of checks) {
      if (check.id === null) continue;
      let found: Array<{ id: number }> = [];
      try {
        found = await this.jsonRpc(
          creds.odooUrl, sessionId, check.model, "search_read",
          [],
          {
            domain: [["id", "=", check.id]], fields: ["id"], limit: 1,
            ...(check.context ? { context: check.context } : {}),
          }
        );
      } catch (e: unknown) {
        // No right to read the model at all, or no such model: the record is out of reach
        if (!(e instanceof OdooRpcError)
          || (e.odooName !== "odoo.exceptions.AccessError" && e.odooName !== "builtins.KeyError")) throw e;
      }
      if (found.length > 0) continue;
      await onMissing(check);
      throw new OutboxBlockedError(
        `${check.label} #${check.id} est introuvable, archivé ou inaccessible sur ${creds.odooUrl}.`,
        check.reason,
        [],
        opKind,
        opId
      );
    }
  }

  // ─── Targets ──────────────────────────────────────────────────────────────

  /**
   * The choice last made for new records of a kind on this server, if any:
   * a task's project. A lead's partner and revenue are not remembered: a
   * client belongs to one opportunity, not to the next.
   */
  async lastTarget(configId: string, kind: TargetKind): Promise<Target | null> {
    if (kind !== "task") return null;
    const pref = await this.db.getSyncTargetPref(configId, TASK_CREATE);
    if (!pref) return null;
    return { projectId: pref.params.projectId ?? null, projectName: pref.params.projectName ?? null };
  }

  /** The project last chosen for new tasks on this server, if any. */
  async lastTaskTarget(configId: string): Promise<TaskTarget | null> {
    return this.lastTarget(configId, "task") as Promise<TaskTarget | null>;
  }

  /** Kinds of target last checked for this server in the picker; a task by default. */
  async lastKinds(configId: string): Promise<TargetKind[]> {
    const pref = await this.db.getSyncTargetPref(configId, TARGET_KINDS_PREF);
    const kinds = (pref?.params.kinds ?? []).filter((k: string) => (TARGET_KINDS as string[]).includes(k));
    return kinds.length > 0 ? kinds : ["task"];
  }

  async setLastKinds(configId: string, kinds: TargetKind[]): Promise<void> {
    await this.db.setSyncTargetPref({
      configId, kind: TARGET_KINDS_PREF, params: { kinds }, updatedAt: new Date().toISOString(),
    });
  }

  /** See TargetState. */
  async targetState(noteId: string, configId: string, kind: TargetKind): Promise<TargetState> {
    const def = KINDS[kind];
    const known = await this.db.findNoteLink(noteId, configId, def.model, "create", true);
    if (known?.remoteState === "ok") return { state: "linked", resId: known.resId };
    const op = await this.outbox.find(noteId, configId, def.opKind);
    if (op) {
      const reason = op.status === "incomplete" ? "incomplete" : op.params.blockedReason ?? null;
      if (op.status === "incomplete"
        || (op.status === "blocked" && reason !== null && CHOOSE_AGAIN_REASONS.has(reason))) {
        const target = def.choiceKeys.some((k) => k in op.params)
          ? targetOfParams(kind, op.params)
          : await this.lastTarget(configId, kind);
        return { state: "choose", op, reason, target };
      }
      return { state: "queued", op };
    }
    const target = await this.lastTarget(configId, kind);
    if (known) return { state: "choose", op: null, reason: "deleted", target, deletedResId: known.resId };
    return { state: "choose", op: null, reason: null, target };
  }

  /** targetState for the note's task. */
  async taskTargetState(noteId: string, configId: string): Promise<TargetState> {
    return this.targetState(noteId, configId, "task");
  }

  /**
   * Records where the note's record of a kind goes on this server, before
   * it is pushed: queues the kind's creation with target, or puts the
   * waiting one (state "choose") back in the queue with it; a task's
   * target is remembered as the server's last choice. For a record
   * deleted on the server, queuing it is the user's confirmation to
   * recreate it (see pushNote). "later" (choices unknown) queues the
   * creation as "incomplete", or parks the waiting one so, its former
   * block reason and error cleared (and its project or partner, when that
   * one was missing; a typed revenue stays): nothing is sent until a
   * choice is made. laterParams are stored with a "later" choice (a lead's
   * typed revenue). Does nothing
   * for a note already linked there for that kind or whose creation is
   * queued for another reason. Returns the operation.
   */
  async setTarget(
    noteId: string,
    configId: string,
    kind: TargetKind,
    target: Target | "later",
    laterParams: Record<string, any> = {}
  ): Promise<OutboxOp | null> {
    const def = KINDS[kind];
    const current = await this.targetState(noteId, configId, kind);
    if (current.state === "linked" || current.state === "queued") return null;
    const now = new Date().toISOString();
    if (target !== "later" && kind === "task") {
      await this.db.setSyncTargetPref({
        configId, kind: TASK_CREATE, params: targetParams("task", target), updatedAt: now,
      });
    }
    const op = current.op;
    if (!op) {
      // An invoice tied to the note's task or opportunity being created waits for it
      const tieKind = kind === "invoice" && target !== "later" ? (target as InvoiceTarget).linkKind : null;
      const tieOp = tieKind ? await this.outbox.find(noteId, configId, KINDS[tieKind].opKind) : null;
      return this.outbox.enqueue({
        noteId, configId, kind: def.opKind,
        params: target === "later" ? laterParams : targetParams(kind, target),
        status: target === "later" ? "incomplete" : "queued",
        dependsOn: tieOp?.id ?? null,
      });
    }
    if (target === "later") {
      await this.outbox.markIncomplete(op.id, {
        ...laterParams,
        blockedReason: null,
        candidates: [],
        ...(current.reason === "project_missing" ? { projectId: null, projectName: null } : {}),
        ...(current.reason === "partner_missing" ? { partnerId: null, partnerName: null } : {}),
      });
    } else {
      await this.outbox.complete(op.id, { ...targetParams(kind, target), blockedReason: null, candidates: [] });
    }
    return this.db.getOutboxOp(op.id);
  }

  /**
   * Stops sending the note to this server as kind, for a kind the user
   * unchecked while it waited (a creation blocked or left for later, or a
   * record deleted on the server): cancels its creation and dismisses its
   * deleted link, so neither the picker nor a push asks for it again. A
   * live link is left alone: nothing here deletes on the server.
   */
  async dropTarget(noteId: string, configId: string, kind: TargetKind): Promise<void> {
    const def = KINDS[kind];
    const op = await this.outbox.find(noteId, configId, def.opKind);
    if (op) await this.outbox.cancel(op.id);
    // Every deleted link of the kind: a recreated, then deleted, record leaves several
    for (const link of await this.db.getNoteLinks(noteId)) {
      if (link.configId === configId && link.model === def.model && link.kind === "create"
        && link.remoteState === "deleted") {
        await this.db.setNoteLinkDismissed(link.id);
      }
    }
    await this.db.refreshNoteSyncStatus(noteId);
  }

  /** setTarget for the note's task. */
  async setTaskTarget(noteId: string, configId: string, target: TaskTarget | "later"): Promise<OutboxOp | null> {
    return this.setTarget(noteId, configId, "task", target);
  }

  /**
   * The values a note's record of a kind is written with; a create adds
   * createValues.
   */
  private async payloadFor(
    kind: TargetKind,
    creds: SyncCredentials,
    sessionId: string,
    note: Note,
    odooVersion: number,
    clientUuid: string | null
  ): Promise<Record<string, any>> {
    if (kind === "task") return this.taskPayloadFor(creds, sessionId, note, odooVersion, clientUuid);
    if (kind === "invoice") return this.buildInvoicePayload(note, clientUuid);
    const tagIds = await this.resolveTags(creds, sessionId, note.tags, KINDS.lead.tagModel!);
    return this.buildLeadPayload(note, tagIds, clientUuid);
  }

  /** The project.task values of a note, tags resolved, geo probed. */
  private async taskPayloadFor(
    creds: SyncCredentials,
    sessionId: string,
    note: Note,
    odooVersion: number,
    clientUuid: string | null
  ): Promise<Record<string, any>> {
    const tagIds = await this.resolveTags(creds, sessionId, note.tags);
    const geoPoint = this.buildGeoMultiPoint(note.entries);
    const withGeo = geoPoint !== null && await this.hasTaskGeoField(creds, sessionId);
    return this.buildTaskPayload(note, tagIds, odooVersion, withGeo ? geoPoint : null, clientUuid);
  }

  /**
   * Records a successful push under the note's lock: writes newLink when
   * given, then marks the server "synced", or "pending" when the note
   * changed since fingerprint was taken. A note deleted meanwhile gets no
   * link.
   */
  private async settlePush(
    noteId: string,
    configId: string,
    fingerprint: string,
    now: string,
    newLink: NoteLink | null
  ): Promise<void> {
    let noteGone = false;
    await this.db.updateNotePerServerStatus(noteId, async (perServer) => {
      const current = await this.db.getNoteById(noteId);
      if (!current) { noteGone = true; return; }
      if (newLink) await this.db.addNoteLink(newLink);
      perServer[configId] = pushedFingerprint(current) === fingerprint ? "synced" : "pending";
    });
    if (noteGone) return;
    await this.db.setNoteSyncInfo(noteId, { lastSyncedAt: now });
    await this.db.refreshNoteSyncStatus(noteId);
  }

  /** Whether project.task has geo_task_point on this server (cached). */
  private async hasTaskGeoField(creds: SyncCredentials, sessionId: string): Promise<boolean> {
    const key = `${creds.odooUrl}|${creds.database}`;
    const known = this._taskGeoField.get(key);
    if (known !== undefined) return known;
    const fields = await this.jsonRpc(
      creds.odooUrl, sessionId, TASK_MODEL, "fields_get",
      [["geo_task_point"]],
      { attributes: ["type"] }
    );
    const present = !!fields && typeof fields === "object" && "geo_task_point" in fields;
    this._taskGeoField.set(key, present);
    return present;
  }

  // ─── Activities and messages ──────────────────────────────────────────────

  /**
   * The note's activities and messages on one server (see AttachedState),
   * dismissed links left out: its links, oldest first, then its
   * creations. A creation whose record is linked already (its row not
   * deleted yet) is left out: the link is its outcome.
   */
  async attachedStates(noteId: string, configId: string): Promise<AttachedState[]> {
    const links = (await this.db.getNoteLinks(noteId))
      .filter((l) => l.configId === configId && isAttachedKind(l.kind) && l.remoteState !== "dismissed")
      .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    const states: AttachedState[] = links.map((link) => ({
      kind: link.kind as AttachedKind,
      state: link.remoteState === "ok" ? "linked" : link.remoteState === "done" ? "done" : "deleted",
      link,
      target: activityOfParams(link.params ?? {}),
    }));
    for (const kind of ATTACHED_KINDS) {
      for (const op of await this.outbox.findAll(noteId, configId, ATTACHED[kind].opKind)) {
        if (links.some((l) => l.clientUuid === op.clientUuid)) continue;
        const target = activityOfParams(op.params);
        const reason = op.status === "incomplete" ? "incomplete" : op.params.blockedReason ?? null;
        if (op.status === "incomplete"
          || (op.status === "blocked" && reason !== null && CHOOSE_AGAIN_REASONS.has(reason))) {
          states.push({ kind, state: "choose", op, reason: reason!, target });
        } else {
          states.push({ kind, state: "queued", op, target });
        }
      }
    }
    return states;
  }

  /** attachedStates of the activities only. */
  async activityStates(noteId: string, configId: string): Promise<AttachedState[]> {
    return (await this.attachedStates(noteId, configId)).filter((a) => a.kind === "activity");
  }

  /**
   * Queues a new activity or message of the note on this server, or, with
   * opId, gives a creation of that kind waiting for a choice (state
   * "choose") its new target and puts it back in the queue, its block
   * cleared. A target with no record yet (resId null, chosen offline with
   * nothing in the cache) is stored "incomplete": nothing is sent until a
   * record is chosen. A message keeps only the record of its target. opId
   * of a creation not waiting for a choice changes nothing. Returns the
   * operation.
   */
  async setAttached(
    noteId: string,
    configId: string,
    kind: AttachedKind,
    target: ActivityTarget,
    opId: string | null = null
  ): Promise<OutboxOp | null> {
    const params = activityParams(kind === "message"
      ? { resModel: target.resModel, resId: target.resId, resName: target.resName, typeId: null, deadline: null, userId: null }
      : target);
    const complete = target.resId !== null && !!target.resModel;
    if (!opId) {
      return this.outbox.enqueue({
        noteId, configId, kind: ATTACHED[kind].opKind, params, status: complete ? "queued" : "incomplete",
      });
    }
    const waiting = (await this.attachedStates(noteId, configId))
      .find((a) => a.kind === kind && a.state === "choose" && a.op.id === opId);
    if (!waiting) return null;
    const cleared = { ...params, blockedReason: null, candidates: [] };
    if (complete) await this.outbox.complete(opId, cleared);
    else await this.outbox.markIncomplete(opId, cleared);
    return this.db.getOutboxOp(opId);
  }

  /** setAttached for an activity. */
  async setActivity(
    noteId: string,
    configId: string,
    target: ActivityTarget,
    opId: string | null = null
  ): Promise<OutboxOp | null> {
    return this.setAttached(noteId, configId, "activity", target, opId);
  }

  /** setAttached for a message posted in the record's chatter. */
  async setMessage(
    noteId: string,
    configId: string,
    target: ActivityTarget,
    opId: string | null = null
  ): Promise<OutboxOp | null> {
    return this.setAttached(noteId, configId, "message", target, opId);
  }

  /**
   * Cancels one of the note's activity or message creations (the user
   * removed it from the picker before it reached the server). One already
   * created stays: nothing here deletes on the server.
   */
  async dropAttached(noteId: string, opId: string): Promise<void> {
    const op = await this.db.getOutboxOp(opId);
    if (!op || op.noteId !== noteId || !ATTACHED_KINDS.some((k) => ATTACHED[k].opKind === op.kind)) return;
    await this.outbox.cancel(opId);
    await this.db.refreshNoteSyncStatus(noteId);
  }

  /**
   * The activities and messages part of pushNoteNow: runs the note's
   * creations of both kinds on this server (only options.onlyAttachedOp
   * when set), then writes each one that was live before them (see
   * writeActivity, writeMessage). An activity created here is written only
   * when the note is done, to mark it done at once. A creation whose
   * record is already linked (cut short after the link, before its row
   * was deleted) is cancelled, not run: its marker search would link the
   * record a second time. Each failure goes to keep.
   */
  private async pushAttached(
    creds: SyncCredentials,
    noteId: string,
    options: PushOptions,
    fingerprint: string,
    keep: (e: unknown) => void
  ): Promise<void> {
    const configId = syncConfigIdOf(creds);
    const links = async () => (await this.db.getNoteLinks(noteId))
      .filter((l) => l.configId === configId && isAttachedKind(l.kind));
    const live = async () => (await links()).filter((l) => l.remoteState === "ok");
    const before = await live();
    const linkedUuids = new Set((await links()).filter((l) => l.clientUuid).map((l) => l.clientUuid));
    for (const kind of ATTACHED_KINDS) {
      const ops = (await this.outbox.findAll(noteId, configId, ATTACHED[kind].opKind))
        .filter((op) => !options.onlyAttachedOp || op.id === options.onlyAttachedOp);
      for (const op of ops) {
        if (linkedUuids.has(op.clientUuid)) {
          await this.outbox.cancel(op.id);
          await this.db.refreshNoteSyncStatus(noteId);
          continue;
        }
        try {
          await this.runAttachedCreate(kind, creds, op, options, fingerprint);
        } catch (e: unknown) {
          keep(e);
        }
      }
    }
    const done = (await this.db.getNoteById(noteId))?.done ?? false;
    const created = (await live()).filter((l) => l.kind === "activity" && !before.some((b) => b.id === l.id));
    const toWrite = [...(options.onlyAttachedOp ? [] : before), ...(done ? created : [])];
    for (const link of toWrite) {
      try {
        if (link.kind === "message") await this.writeMessage(creds, noteId, link, fingerprint);
        else await this.writeActivity(creds, noteId, link, fingerprint);
      } catch (e: unknown) {
        keep(e);
      }
    }
  }

  /**
   * One creation of pushAttached, under the rules of a kind's creation
   * (see pushNote): a background push skips it while it is not due; an
   * incomplete one never runs; a tap runs a blocked or failed one again;
   * options.adopt for its opId settles an ambiguous one. Before the
   * create, the record's model is checked (checkAttachedModel), then the
   * record, and for an activity its type and user (checkChosen).
   */
  private async runAttachedCreate(
    kind: AttachedKind,
    creds: SyncCredentials,
    op: OutboxOp,
    options: PushOptions,
    fingerprint: string
  ): Promise<void> {
    const def = ATTACHED[kind];
    if (!options.userInitiated && !this.outbox.isDue(op, options.force)) return;
    if (op.status === "incomplete") {
      throw new OutboxBlockedError(
        `${def.waitingChoice} sur ${creds.odooUrl}.`, "incomplete", [], def.opKind, op.id
      );
    }
    const adopt = options.adopt?.kind === kind && options.adopt.opId === op.id ? options.adopt.resId : null;
    await this.outbox.attempt(op.id, (running) => {
      const target = activityOfParams(running.params);
      const checks: ChosenRecordCheck[] = [{
        model: target.resModel, id: target.resId, reason: "record_missing", label: "L'enregistrement",
        context: WITH_ARCHIVED,
      }];
      if (kind === "activity") {
        checks.push(
          { model: ACTIVITY_TYPE_MODEL, id: target.typeId, reason: "type_missing", label: "Le type d'activité" },
          { model: USER_MODEL, id: target.userId, reason: "user_missing", label: "L'utilisateur" },
        );
      }
      const check = async (sessionId: string) => {
        await this.checkAttachedModel(kind, creds, target.resModel, running.id);
        await this.checkChosen(creds, sessionId, checks, def.opKind, running.id);
      };
      const spec: CreateSpec = kind === "activity"
        ? {
            model: ACTIVITY_MODEL,
            opKind: def.opKind,
            markerField: "note",
            values: async (_sessionId, _odooVersion, note) => this.buildActivityPayload(note, running.clientUuid),
            createValues: () => ({
              res_id: target.resId,
              ...(target.typeId != null ? { activity_type_id: target.typeId } : {}),
              ...(target.deadline ? { date_deadline: target.deadline } : {}),
              ...(target.userId != null ? { user_id: target.userId } : {}),
            }),
            // res_model_id is resolved from default_res_model by mail.activity's
            // default_get, without reading ir.model (admin only on 17 and 18)
            context: { default_res_model: target.resModel },
            check,
            link: { kind: "activity", params: activityParams(target) },
          }
        : {
            model: MESSAGE_MODEL,
            opKind: def.opKind,
            markerField: "body",
            markerScope: [["model", "=", target.resModel], ["res_id", "=", target.resId]],
            values: async (_sessionId, _odooVersion, note) => ({ body: this.messageBody(note, running.clientUuid) }),
            createValues: () => ({}),
            create: (sessionId, odooVersion, values) => this.jsonRpc(
              creds.odooUrl, sessionId, target.resModel, "message_post", [[target.resId]],
              messagePostKwargs(values.body, odooVersion)
            ),
            write: async (sessionId, resId, values) => {
              const current = await this.readMessage(creds, sessionId, resId);
              if (!current) {
                throw new OdooRpcError(`${MESSAGE_MODEL} #${resId} introuvable sur ${creds.odooUrl}`, "odoo.exceptions.MissingError");
              }
              await this.updateMessage(creds, sessionId, resId, values.body, current.attachmentIds);
            },
            check,
            link: { kind: "message", params: activityParams(target) },
            sentParams: (values) => ({ bodyHash: textHash(values.body) }),
          };
      // A model without mail.thread or mail.activity.mixin fails inside the create
      spec.refusedErrors = ["builtins.AttributeError"];
      return this.createWithMarker(creds, running, adopt, fingerprint, spec);
    });
    // The row is deleted only once the attempt settled: derive the status without it
    await this.db.refreshNoteSyncStatus(op.noteId);
  }

  /**
   * Blocks a creation as "model_unusable" when the probe of its record's
   * model (cached for a day, see CapabilityService.ensure) says the server
   * lacks the model, or its activities (activity) or chatter (message): a
   * model typed by its technical name is probed only here. A probe that
   * cannot reach the server does not block; the create then decides.
   */
  private async checkAttachedModel(kind: AttachedKind, creds: SyncCredentials, model: string, opId: string): Promise<void> {
    const cap = await this.capabilities.ensure(creds, model, { online: true });
    const reason = unusableReason(cap, [kind === "activity" ? "activities" : "chatter"]);
    if (reason !== "missing_model" && reason !== "no_activities" && reason !== "no_chatter") return;
    throw new OutboxBlockedError(
      `Le modèle ${model} n'accepte pas ${kind === "activity" ? "d'activités" : "de messages"} sur ${creds.odooUrl}.`,
      "model_unusable", [], ATTACHED[kind].opKind, opId
    );
  }

  /**
   * Writes one live activity: its summary and note from the note, or,
   * when the note is done, action_feedback, which marks it done on the
   * server (removed, or archived when its type keeps done activities); the
   * link is then "done". An activity gone on the server (MissingError:
   * done or cancelled there) marks the link deleted without raising (see
   * markAttachedGone). On Odoo 17+, where an activity done on the server
   * is archived when its type keeps done activities, its active flag is
   * read first: an archived one turns the link "done" untouched, since
   * action_feedback would mark it done, and post that, a second time.
   */
  private async writeActivity(
    creds: SyncCredentials,
    noteId: string,
    link: NoteLink,
    fingerprint: string
  ): Promise<void> {
    const note = await this.db.getNoteById(noteId);
    if (!note) return;
    await this.callWithAuth(creds, async (sessionId, odooVersion) => {
      let gone = false;
      let archived = false;
      try {
        if (odooVersion >= 17) {
          const rows: Array<{ id: number; active: boolean }> = await this.jsonRpc(
            creds.odooUrl, sessionId, ACTIVITY_MODEL, "search_read", [],
            { domain: [["id", "=", link.resId]], fields: ["active"], limit: 1, context: WITH_ARCHIVED }
          );
          gone = rows.length === 0;
          archived = rows[0]?.active === false;
        }
        // Archived: done on the server already, nothing to write nor to mark
        if (!gone && !archived && note.done) {
          await this.jsonRpc(creds.odooUrl, sessionId, ACTIVITY_MODEL, "action_feedback", [[link.resId]], { feedback: false });
        } else if (!gone && !archived) {
          await this.jsonRpc(creds.odooUrl, sessionId, ACTIVITY_MODEL, "write", [
            [link.resId], this.buildActivityPayload(note, link.clientUuid ?? null),
          ]);
        }
      } catch (e: unknown) {
        if (!(e instanceof OdooRpcError) || e.odooName !== "odoo.exceptions.MissingError") throw e;
        gone = true;
      }
      if (gone) {
        await this.markAttachedGone(noteId, link);
        return;
      }
      if (note.done || archived) await this.db.setNoteLinkDone(link.id);
      const now = new Date().toISOString();
      await this.db.setNoteLinkSyncedAt(link.id, now);
      await this.settlePush(noteId, link.configId, fingerprint, now, null);
    });
  }

  /**
   * Writes one live message: its body is replaced with the note's (see
   * updateMessage), unless it is the body last sent (link params
   * bodyHash): an edit shows as such in the chatter, and a push that
   * changes nothing of the text must not add one. The message is read
   * first through call_kw (see readMessage): the edit route accepts
   * anonymous requests, so a session no longer valid would reach it as the
   * public user and get NotFound, where call_kw answers "session expired"
   * and the session is renewed. A message gone, deleted in the chatter
   * (Odoo empties it), or no longer the user's to edit (NotFound) marks the
   * link deleted without raising (see markAttachedGone).
   */
  private async writeMessage(
    creds: SyncCredentials,
    noteId: string,
    link: NoteLink,
    fingerprint: string
  ): Promise<void> {
    const note = await this.db.getNoteById(noteId);
    if (!note) return;
    const body = this.messageBody(note, link.clientUuid ?? null);
    const hash = textHash(body);
    await this.callWithAuth(creds, async (sessionId) => {
      if (link.params?.bodyHash !== hash) {
        const current = await this.readMessage(creds, sessionId, link.resId);
        let gone = !current;
        try {
          if (current) await this.updateMessage(creds, sessionId, link.resId, body, current.attachmentIds);
        } catch (e: unknown) {
          if (!(e instanceof OdooRpcError) || !MESSAGE_GONE_ERRORS.has(e.odooName ?? "")) throw e;
          gone = true;
        }
        if (gone) {
          await this.markAttachedGone(noteId, link);
          return;
        }
        await this.db.setNoteLinkParams(link.id, { ...(link.params ?? {}), bodyHash: hash });
      }
      const now = new Date().toISOString();
      await this.db.setNoteLinkSyncedAt(link.id, now);
      await this.settlePush(noteId, link.configId, fingerprint, now, null);
    });
  }

  /**
   * A posted message's attachments, read through call_kw (auth "user"), or
   * null when it is gone: not found, or deleted in the chatter, which
   * empties its body and drops its attachments rather than removing it.
   */
  private async readMessage(
    creds: SyncCredentials,
    sessionId: string,
    messageId: number
  ): Promise<{ attachmentIds: number[] } | null> {
    const rows: Array<{ body: string | false; attachment_ids: number[] }> = await this.jsonRpc(
      creds.odooUrl, sessionId, MESSAGE_MODEL, "search_read", [],
      { domain: [["id", "=", messageId]], fields: ["body", "attachment_ids"], limit: 1 }
    );
    const row = rows[0];
    if (!row) return null;
    const text = String(row.body || "").replace(/<[^>]*>/g, "").trim();
    const attachmentIds = row.attachment_ids ?? [];
    return text || attachmentIds.length > 0 ? { attachmentIds } : null;
  }

  /**
   * Replaces a posted message's body through the web client's own edit
   * route, available from Odoo 16 to 18: only the author of a logged note
   * may do so. attachment_ids is the message's whole list once edited, so
   * its current attachments are passed back, as the web client does.
   */
  private async updateMessage(
    creds: SyncCredentials,
    sessionId: string,
    messageId: number,
    body: string,
    attachmentIds: number[]
  ): Promise<void> {
    await this.rpc.jsonRoute(creds.odooUrl, sessionId, "/mail/message/update_content", {
      message_id: messageId, body, attachment_ids: attachmentIds,
    });
  }

  /**
   * An activity or message gone on the server: its link turns deleted, kept
   * as history, and the server leaves the note's queue when nothing else of
   * the note lives or waits there.
   */
  private async markAttachedGone(noteId: string, link: NoteLink): Promise<void> {
    await this.db.setNoteLinkRemoteDeleted(link.id);
    const waiting = (await this.db.getOutboxOpsForNote(noteId)).some((op) => op.configId === link.configId);
    if (!(await this.hasOtherLiveLink(noteId, link.configId, (l) => l.id === link.id)) && !waiting) {
      await this.db.clearNotePerServerStatus(noteId, link.configId);
    }
    await this.db.refreshNoteSyncStatus(noteId);
  }

  /**
   * The mail.activity values a note writes: its title as summary and its
   * HTML (with the marker, see buildTaskPayload) as note. The record, type,
   * deadline and user are create-only.
   */
  private buildActivityPayload(note: Note, clientUuid: string | null): Record<string, any> {
    return { summary: note.title, note: this.withMarker(this.buildHtml(note.entries), clientUuid) };
  }

  /** The body of a note's message: its title in bold, then its HTML, then the marker. */
  private messageBody(note: Note, clientUuid: string | null): string {
    const title = note.title.trim() ? `<p><b>${this.escapeHtml(note.title)}</b></p>` : "";
    return this.withMarker([title, this.buildHtml(note.entries)].filter(Boolean).join("\n"), clientUuid);
  }

  /** html followed by the marker of clientUuid (see clientMarker), when given. */
  private withMarker(html: string, clientUuid: string | null): string {
    return clientUuid
      ? [html, `<p><small>${clientMarker(clientUuid)}</small></p>`].filter(Boolean).join("\n")
      : html;
  }

  // ─── Poll ────────────────────────────────────────────────────────────────

  /**
   * Lightweight poll — fetches only the ids of the tasks linked on this
   * server (any project) written since lastSync. Returns those ids; no
   * linked task means no request.
   */
  async pollForChanges(creds: SyncCredentials, lastSync: Date): Promise<number[]> {
    const linkedIds = [...(await this.linkedTaskIds(syncConfigIdOf(creds))).keys()];
    if (linkedIds.length === 0) return [];
    return this.callWithAuth(creds, async (sessionId, _odooVersion) => {
      const results: { id: number; write_date: string }[] = await this.jsonRpc(
        creds.odooUrl, sessionId, "project.task", "search_read",
        [],
        {
          domain: [
            ["id", "in", linkedIds],
            ["write_date", ">", lastSync.toISOString()],
          ],
          fields: ["id", "write_date"],
          limit: 200,
          context: WITH_ARCHIVED,
        }
      );
      return results.map((r) => r.id);
    });
  }

  // ─── Pull ────────────────────────────────────────────────────────────────

  /**
   * Pulls tasks modified since lastSync from Odoo.
   * Updates metadata for the notes linked to those tasks on this server.
   * Returns the count of updated notes.
   *
   * Note: text entries are not re-parsed from HTML in v1 —
   * mobile is the primary author of content.
   */
  async pullNotes(creds: SyncCredentials, lastSync: Date): Promise<number> {
    return (await this.pullTasks(creds, lastSync.toISOString())).updated;
  }

  /**
   * Reads, page by page, the tasks linked on this target, whatever their
   * project, with write_date >= since (archived ones included) and copies title, pinned, archived and — on
   * Odoo 17+ — done onto the notes linked to them on this target. A note
   * still "pending" or in "error" for this server is left
   * untouched: its local edits have not reached the server yet, and
   * overwriting them would lose them. A note the pull changes becomes
   * pending for its other servers, and for this one when another kind of
   * it (an opportunity) lives there too. Returns the notes changed and the
   * highest write_date read (null when no task came back, or none is
   * linked: then nothing is requested).
   */
  private async pullTasks(
    creds: SyncCredentials,
    since: string
  ): Promise<{ updated: number; maxWriteDate: string | null }> {
    const configId = syncConfigIdOf(creds);
    const linkByResId = await this.linkedTaskIds(configId);
    if (linkByResId.size === 0) return { updated: 0, maxWriteDate: null };
    const linkedIds = [...linkByResId.keys()];
    return this.callWithAuth(creds, async (sessionId, odooVersion) => {
      const fields = [
        "id", "name", "priority", "active",
        "tag_ids", "date_deadline", "write_date",
        ...(odooVersion >= 17 ? ["state"] : []),
      ];

      let updated = 0;
      let maxWriteDate: string | null = null;
      // Keyset paging. search_read returns write_date truncated to the
      // second while the server compares the stored value with its
      // microseconds, so "= T" matches nothing: the next page asks for
      // ">= T" minus the ids already read at T. A task rewritten during the
      // pull moves to the end without shifting the rows not read yet.
      let lastWriteDate = since;
      let seenAtLast: number[] = [];
      for (let page = 0; page < PULL_MAX_PAGES; page++) {
        const domain: any[] = [
          ["id", "in", linkedIds],
          ["write_date", ">=", lastWriteDate],
          ...(seenAtLast.length > 0 ? [["id", "not in", seenAtLast]] : []),
        ];
        const tasks: any[] = await this.jsonRpc(
          creds.odooUrl, sessionId, TASK_MODEL, "search_read",
          [],
          {
            domain,
            fields,
            limit: PULL_PAGE_SIZE,
            order: "write_date asc, id asc",
            context: WITH_ARCHIVED,
          }
        );

        for (const task of tasks) {
          if (task.write_date && (!maxWriteDate || task.write_date > maxWriteDate)) {
            maxWriteDate = task.write_date;
          }
          const link = linkByResId.get(task.id);
          if (!link) continue;
          if (await this.applyPulledTask(link.noteId, configId, task, odooVersion)) updated++;
        }
        if (tasks.length < PULL_PAGE_SIZE) break;
        const pageLast = tasks[tasks.length - 1].write_date;
        const atPageLast = tasks.filter((t) => t.write_date === pageLast).map((t) => t.id);
        seenAtLast = pageLast === lastWriteDate ? [...seenAtLast, ...atPageLast] : atPageLast;
        lastWriteDate = pageLast;
      }
      return { updated, maxWriteDate };
    });
  }

  /** Live task links of one config, by task id. */
  private async linkedTaskIds(configId: string): Promise<Map<number, NoteLink>> {
    return new Map(
      (await this.db.getNoteLinksForConfig(configId))
        .filter((l) => l.model === TASK_MODEL && l.kind === "create" && l.remoteState === "ok")
        .map((l) => [l.resId, l])
    );
  }

  /**
   * Copies one pulled task onto its note, under the note's sync lock so a
   * concurrent edit is either seen (the note is then pending and left
   * alone) or applied after. Returns whether the note changed; a changed
   * note becomes pending for its other servers.
   */
  private async applyPulledTask(
    noteId: string,
    configId: string,
    task: any,
    odooVersion: number
  ): Promise<boolean> {
    let changed = false;
    let applied = false;
    await this.db.updateNotePerServerStatus(noteId, async (perServer) => {
      const status = perServer[configId];
      if (status === "pending" || status === "error") return;
      const local = await this.db.getNoteById(noteId);
      if (!local) return;
      const updatedNote = {
        ...local,
        title: task.name,
        pinned: task.priority === "1",
        archived: !task.active,
        ...(odooVersion >= 17 ? { done: task.state === TASK_STATE_DONE } : {}),
      };
      changed = updatedNote.title !== local.title || updatedNote.pinned !== local.pinned
        || updatedNote.archived !== local.archived || updatedNote.done !== local.done;
      if (changed) await this.db.updateNote(noteId, updatedNote);
      // Another kind of the note on this server (an opportunity) still has the old values
      perServer[configId] = changed && await this.hasOtherLiveKind(noteId, configId, "task") ? "pending" : "synced";
      applied = true;
    });
    if (!applied) return false;
    const now = new Date().toISOString();
    const link = await this.db.findNoteLink(noteId, configId, TASK_MODEL, "create");
    if (link) await this.db.setNoteLinkSyncedAt(link.id, now);
    if (changed) {
      await this.db.setNoteSyncInfo(noteId, { lastSyncedAt: now });
      // The note's other servers still hold the previous values
      await this.db.markNotePendingForConfigs(noteId, await this.db.getLiveLinkConfigIds(noteId, configId));
      this.onNotePulled?.(noteId);
    }
    await this.db.refreshNoteSyncStatus(noteId);
    return changed;
  }

  // ─── Sync all ────────────────────────────────────────────────────────────

  /** Notes syncAll would push to this config: pending or in error. */
  async pendingNoteIds(configId: string): Promise<string[]> {
    return this.db.getNoteIdsPendingForConfig(configId);
  }

  /** Called with next_attempt_at each time an outbox row turns failed. */
  onRetryScheduled: ((nextAttemptAt: string) => void) | null = null;

  /** See OutboxService.nextRetryAt. */
  async nextRetryAt(configId: string): Promise<string | null> {
    return this.outbox.nextRetryAt(configId);
  }

  /**
   * Whether a syncAll without force would send anything to this config: a
   * note pending or in error whose creation is not waiting, or a due
   * outbox operation not waiting for another (its dependency, or the
   * creation of the record an invoice is tied to).
   */
  async hasDueWork(configId: string): Promise<boolean> {
    const ops = await this.db.getOutboxOpsForConfig(configId);
    for (const op of ops) {
      // drain leaves an operation whose dependency is still queued
      if (!this.outbox.isDue(op) || (op.dependsOn && ops.some((o) => o.id === op.dependsOn))) continue;
      if (!(await this.tieWaiting(op))) return true;
    }
    for (const noteId of await this.db.getNoteIdsPendingForConfig(configId)) {
      if (await this.hasDueKind(noteId, configId, false)) return true;
    }
    return false;
  }

  /**
   * Whether a background push of the note would send something to this
   * server: a kind with a live link, a creation that is due, a deleted
   * record (the push takes the server out of the queue), or nothing at all
   * (a task is created); or a live activity or message, or a creation of
   * one that is due. A note whose every target is a creation waiting for the user
   * or its delay has nothing due.
   */
  private async hasDueKind(noteId: string, configId: string, force: boolean): Promise<boolean> {
    for (const kind of await this.noteKinds(noteId, configId)) {
      const def = KINDS[kind];
      const known = await this.db.findNoteLink(noteId, configId, def.model, "create", true);
      if (known?.remoteState === "ok") return true;
      const op = await this.outbox.find(noteId, configId, def.opKind);
      if (op ? this.outbox.isDue(op, force) && !(await this.tieWaiting(op)) : true) return true;
    }
    if ((await this.db.getNoteLinks(noteId)).some((l) =>
      l.configId === configId && isAttachedKind(l.kind) && l.remoteState === "ok")) return true;
    for (const kind of ATTACHED_KINDS) {
      if ((await this.outbox.findAll(noteId, configId, ATTACHED[kind].opKind)).some((op) => this.outbox.isDue(op, force))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Full bidirectional sync for one server:
   * 1. Push every note pending (or in error) for this config — syncConfigId,
   *    or the id derived from creds — then run the server's other due
   *    outbox operations
   * 2. Pull the tasks written since the pull cursor of this config (first
   *    pull: a day before the oldest link synced, else everything), then
   *    move the cursor to the highest write_date read
   *
   * A note is pushed when some kind of it has something due (see
   * hasDueKind); its kinds whose creation waits out its retry delay or
   * for the user (blocked, incomplete) are skipped within the push. force
   * (the network just came back) ignores the delay only.
   */
  async syncAll(
    creds: SyncCredentials,
    syncConfigId?: string,
    options: { force?: boolean } = {}
  ): Promise<SyncResult> {
    const configId = syncConfigId ?? syncConfigIdOf(creds);
    const previous = this._syncAllChain.get(configId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.syncAllNow(creds, configId, options));
    this._syncAllChain.set(configId, current);
    try {
      return await current;
    } finally {
      if (this._syncAllChain.get(configId) === current) this._syncAllChain.delete(configId);
    }
  }

  private async syncAllNow(
    creds: SyncCredentials,
    configId: string,
    options: { force?: boolean }
  ): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, pulled: 0, errors: [] };

    const pushed = new Set<string>();
    for (const noteId of await this.db.getNoteIdsPendingForConfig(configId)) {
      if (!(await this.hasDueKind(noteId, configId, !!options.force))) continue;
      pushed.add(noteId);
      try {
        await this.pushNote(creds, noteId, { force: options.force });
        result.pushed++;
      } catch (e: unknown) {
        result.errors.push(`Push ${noteId}: ${e instanceof Error ? e.message : String(e)}`);
        // Deleted remote task: already dropped from the queue by pushNote
        if (e instanceof RemoteRecordDeletedError) continue;
        await this.db.setNotePerServerStatus(noteId, configId, "error").catch(() => {});
        await this.db.refreshNoteSyncStatus(noteId).catch(() => {});
      }
    }

    const drained = await this.outbox.drain(creds, configId, { force: options.force, skipNoteIds: pushed });
    result.pushed += drained.done;
    result.errors.push(...drained.errors);

    const cursorScope = configId;
    const oldestLink = (await this.db.getNoteLinksForConfig(configId))
      .map((l) => l.lastSyncedAt)
      .filter(Boolean)
      .sort()
      .at(0);
    const since = (await this.db.getSyncPullCursor(cursorScope))
      ?? (oldestLink
        ? new Date(new Date(oldestLink).getTime() - FIRST_PULL_CLOCK_MARGIN_MS).toISOString()
        : new Date(0).toISOString());
    try {
      const pulled = await this.pullTasks(creds, since);
      result.pulled = pulled.updated;
      if (pulled.maxWriteDate) await this.db.setSyncPullCursor(cursorScope, pulled.maxWriteDate);
    } catch (e: unknown) {
      result.errors.push(`Pull: ${e instanceof Error ? e.message : String(e)}`);
    }

    return result;
  }

  // ─── Database discovery ───────────────────────────────────────────────────

  /** Databases the server lists publicly; see OdooRpcClient.listDatabases. */
  listDatabases(url: string): Promise<string[]> {
    return this.rpc.listDatabases(url);
  }

  /** Public server version string; see OdooRpcClient.getServerVersion. */
  getServerVersion(url: string): Promise<string | null> {
    return this.rpc.getServerVersion(url);
  }

  // ─── Odoo explorer ───────────────────────────────────────────────────────

  /**
   * Fetches the Odoo major version and the full list of installed models.
   */
  async getOdooExplorer(creds: SyncCredentials): Promise<{
    version: string;
    models: Array<{ name: string; model: string }>;
  }> {
    return this.callWithAuth(creds, async (sessionId, odooVersion) => {
      const rows: Array<{ name: string; model: string }> = await this.jsonRpc(
        creds.odooUrl, sessionId, "ir.model", "search_read",
        [],
        { domain: [], fields: ["name", "model"], order: "model asc", limit: 500 }
      );
      return {
        version: `Odoo ${odooVersion}`,
        models: rows.map((r) => ({ name: r.name, model: r.model })),
      };
    });
  }

  /**
   * Fetches field definitions and record count for one Odoo model.
   */
  async getOdooModelInfo(
    creds: SyncCredentials,
    modelName: string
  ): Promise<{
    count: number;
    fields: Array<{ name: string; fieldDescription: string; ttype: string }>;
  }> {
    return this.callWithAuth(creds, async (sessionId) => {
      const [rawFields, count] = await Promise.all([
        this.jsonRpc(
          creds.odooUrl, sessionId, "ir.model.fields", "search_read",
          [],
          { domain: [["model", "=", modelName]], fields: ["name", "field_description", "ttype"], order: "name asc", limit: 500 }
        ) as Promise<Array<{ name: string; field_description: string; ttype: string }>>,
        (this.jsonRpc(creds.odooUrl, sessionId, modelName, "search_count", [[]]) as Promise<number>)
          .catch(() => -1),
      ]);
      return {
        count,
        fields: rawFields.map((f) => ({
          name: f.name,
          fieldDescription: f.field_description,
          ttype: f.ttype,
        })),
      };
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Builds the project.task payload for create/write.
   * Excludes fields not available in older Odoo versions, and project_id,
   * which only a create sets (see createTask): a task moved to another
   * project on the server stays there. With clientUuid,
   * the description ends with its marker (see clientMarker), kept on every
   * write so the task stays findable.
   */
  private buildTaskPayload(
    note: Note,
    tagIds: number[],
    odooVersion: number,
    geoPoint: string | null,
    clientUuid: string | null = null
  ): Record<string, any> {
    const html = this.buildHtml(note.entries);
    const payload: Record<string, any> = {
      name: note.title,
      description: clientUuid
        ? [html, `<p><small>${clientMarker(clientUuid)}</small></p>`].filter(Boolean).join("\n")
        : html,
      priority: note.pinned ? "1" : "0",
      active: !note.archived,
      tag_ids: [[6, 0, tagIds]],
      date_deadline: this.getFirstDate(note.entries),
    };

    // state field introduced in Odoo 17
    if (odooVersion >= 17) {
      payload.state = note.done ? TASK_STATE_DONE : "01_in_progress";
    }

    // geo_task_point: only when the note has positions AND the server has the field
    if (geoPoint !== null) {
      payload.geo_task_point = geoPoint;
    }

    return payload;
  }



  /**
   * The crm.lead values a note writes: title, HTML description (with the
   * marker, see buildTaskPayload), tags, and, when the note has a date
   * entry, its local day as date_deadline (a Date field). active, the
   * type, partner and revenue are create-only (see createValues): leads
   * are not pulled back, so writing active would revive an opportunity
   * marked lost (archived) on the server. done and pinned do not map to
   * an opportunity.
   */
  private buildLeadPayload(note: Note, tagIds: number[], clientUuid: string | null): Record<string, any> {
    const html = this.buildHtml(note.entries);
    const day = localDay(this.getFirstDate(note.entries));
    return {
      name: note.title,
      description: clientUuid
        ? [html, `<p><small>${clientMarker(clientUuid)}</small></p>`].filter(Boolean).join("\n")
        : html,
      tag_ids: [[6, 0, tagIds]],
      ...(day ? { date_deadline: day } : {}),
    };
  }

  /**
   * The account.move values a note writes: its title and HTML, with the
   * marker, as the invoice's narration (terms and conditions, free text).
   * Everything else is create-only: an invoice belongs to accounting once
   * drafted.
   */
  private buildInvoicePayload(note: Note, clientUuid: string | null): Record<string, any> {
    const title = note.title.trim() ? `<p><b>${this.escapeHtml(note.title)}</b></p>` : "";
    return { narration: this.withMarker([title, this.buildHtml(note.entries)].filter(Boolean).join("\n"), clientUuid) };
  }

  /** Minimal HTML escaping for user-generated text. */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Converts Application + database name to SyncCredentials. */
  static credentialsFrom(app: Application, database: string): SyncCredentials {
    return { odooUrl: app.url, username: app.username, password: app.password, database };
  }
}
