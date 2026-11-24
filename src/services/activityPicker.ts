import type { ServerCapability } from "./databaseService";
import type { RecordSearch } from "./odoo/recordSearchService";
import type { SyncCredentials } from "./odoo/odooRpcClient";
import { ActivityTypeChoice, ActivityTypeList, defaultDeadline, typesForModel } from "./odoo/activityTypeService";
import { unusableReason, UnusableReason } from "./odoo/capabilityService";
import type { ActivityTarget, AttachedKind, AttachedState, TargetKind, TargetState } from "./syncService";
import { CHOOSE_LATER, ProjectOption } from "./targetPicker";

/**
 * Models offered for an activity or a message, in display order; each is
 * probed and greyed where the server lacks it, or its activities (for an
 * activity) or its chatter (for a message). Any other model is reached
 * through ADVANCED_MODEL, its technical name typed.
 */
export const ACTIVITY_MODELS = [
  "res.partner", "crm.lead", "project.task", "project.project", "sale.order", "account.move", "purchase.order",
];

/** Model select value of a model typed by its technical name. */
export const ADVANCED_MODEL = "__advanced";

/** Record select value of no record chosen yet. */
export const NO_RECORD = "";

/** User select value of the connected user (the server's default). */
export const ME = "me";

/** Type select value of the server's default type. */
export const DEFAULT_TYPE = "";

/** Model each kind of target of the note is, offered as a shortcut. */
const KIND_MODELS: Record<TargetKind, string> = { task: "project.task", lead: "crm.lead" };

export interface ModelOption {
  model: string;
  /**
   * Why the server cannot take an activity, or a message, on it; null when
   * it can or was never probed.
   */
  unusable: Record<AttachedKind, UnusableReason | null>;
}

/** A record of this note on the server (its task, its opportunity), offered first. */
export interface Shortcut {
  kind: TargetKind;
  model: string;
  resId: number;
}

/**
 * One activity or message (kind) in the picker of one server:
 * - linked / done / deleted / queued: what the note already has, shown;
 * - stuck: a creation that failed or is blocked, which removed drops;
 * - choose: a creation waiting for a choice, edited like a draft;
 * - draft: a new one the user is adding.
 * The editing fields hold the choices of choose and draft rows; a message
 * has only its model and record.
 */
export interface ActivityRow {
  key: string;
  kind: AttachedKind;
  status: "linked" | "done" | "deleted" | "queued" | "stuck" | "choose" | "draft";
  opId: string | null;
  /** What the row stands for, as stored (choose, shown rows) or as last built. */
  target: ActivityTarget;
  /** Why a choose or stuck row waits (incomplete, record_missing, …). */
  reason: string | null;
  /** The user removed the row: a draft is forgotten, a creation dropped. */
  removed: boolean;
  model: string;
  advancedModel: string;
  records: ProjectOption[];
  recordSelection: string;
  recordQuery: string;
  recordsFromCache: boolean;
  recordsError: string | null;
  typeSelection: string;
  deadline: string;
  /** The deadline was typed: a change of type no longer recomputes it. */
  deadlineEdited: boolean;
  users: ProjectOption[];
  userSelection: string;
  userQuery: string;
}

/** The activities and messages part of the picker for one server. */
export interface ActivitySection {
  loading: boolean;
  /** Why the section could not be built; it then offers nothing. */
  failed: string | null;
  offline: boolean;
  models: ModelOption[];
  types: ActivityTypeChoice[];
  typesFromCache: boolean;
  shortcuts: Shortcut[];
  /** Day of the note's first date ("YYYY-MM-DD"), the default deadline. */
  noteDay: string | null;
  /** Today when the section was built, for the delays of types. */
  today: string;
  rows: ActivityRow[];
}

export function loadingSection(): ActivitySection {
  return {
    loading: true, failed: null, offline: false, models: [], types: [], typesFromCache: false,
    shortcuts: [], noteDay: null, today: "", rows: [],
  };
}

/** The part of SyncService the activity picker reads and writes. */
export interface ActivitySource {
  attachedStates(noteId: string, configId: string): Promise<AttachedState[]>;
  setAttached(
    noteId: string,
    configId: string,
    kind: AttachedKind,
    target: ActivityTarget,
    opId?: string | null
  ): Promise<{ id: string } | null>;
  dropAttached(noteId: string, opId: string): Promise<void>;
  targetState(noteId: string, configId: string, kind: TargetKind): Promise<TargetState>;
  capabilities: {
    ensure(creds: SyncCredentials, model: string, options: { online: boolean }): Promise<ServerCapability | null>;
  };
  activityTypes: { list(creds: SyncCredentials, options: { online: boolean }): Promise<ActivityTypeList> };
}

/** The model a row's choices are for: the selected one, or the one typed. */
export function rowModel(row: ActivityRow): string {
  return row.model === ADVANCED_MODEL ? row.advancedModel.trim() : row.model;
}

/** Types offered on a row: those of its model, or for any model. */
export function rowTypes(section: ActivitySection, row: ActivityRow): ActivityTypeChoice[] {
  return typesForModel(section.types, rowModel(row));
}

/** The deadline a row gets from its type when none was typed: the note's day, else today plus the delay. */
function deadlineFor(section: ActivitySection, type: ActivityTypeChoice | null): string {
  return section.noteDay ?? defaultDeadline(type, new Date(`${section.today}T12:00:00`));
}

function baseRow(key: string, kind: AttachedKind, status: ActivityRow["status"], target: ActivityTarget): ActivityRow {
  return {
    key, kind, status, opId: null, target, reason: null, removed: false,
    model: target.resModel, advancedModel: "", records: [], recordSelection: NO_RECORD, recordQuery: "",
    recordsFromCache: false, recordsError: null, typeSelection: DEFAULT_TYPE, deadline: target.deadline ?? "",
    deadlineEdited: false, users: [], userSelection: ME, userQuery: "",
  };
}

/** Puts a target's record, type and user in a row's choices; a model not offered goes to ADVANCED_MODEL. */
function withTargetChoices(section: ActivitySection, row: ActivityRow, target: ActivityTarget): ActivityRow {
  const offered = section.models.some((m) => m.model === target.resModel);
  const next: ActivityRow = {
    ...row,
    model: offered || !target.resModel ? target.resModel : ADVANCED_MODEL,
    advancedModel: offered ? "" : target.resModel,
    typeSelection: target.typeId != null ? String(target.typeId) : DEFAULT_TYPE,
    userSelection: target.userId != null ? String(target.userId) : ME,
    users: target.userId != null ? [{ value: String(target.userId), name: target.userName || `#${target.userId}` }] : [],
  };
  const missing = row.reason === "record_missing";
  if (target.resId != null && !missing) {
    next.records = [{ value: String(target.resId), name: target.resName || `#${target.resId}` }];
    next.recordSelection = String(target.resId);
  } else if (row.reason === "incomplete" && canDeferRecord(section, next)) {
    // Left for later and still offline: it stays left for later
    next.recordSelection = CHOOSE_LATER;
  }
  if (row.reason === "type_missing") next.typeSelection = DEFAULT_TYPE;
  if (row.reason === "user_missing") { next.userSelection = ME; next.users = []; }
  if (!next.deadline) next.deadline = deadlineFor(section, typeById(section, next.typeSelection));
  return next;
}

function typeById(section: ActivitySection, value: string): ActivityTypeChoice | null {
  return value === DEFAULT_TYPE ? null : section.types.find((t) => String(t.id) === value) ?? null;
}

/** The row of one activity or message state. */
function stateRow(section: ActivitySection, state: AttachedState): ActivityRow {
  if (state.state === "linked" || state.state === "done" || state.state === "deleted") {
    return baseRow(`link-${state.link.id}`, state.kind, state.state, state.target);
  }
  if (state.state === "queued") {
    const stuck = state.op.status === "failed" || state.op.status === "blocked";
    return {
      ...baseRow(`op-${state.op.id}`, state.kind, stuck ? "stuck" : "queued", state.target),
      opId: state.op.id,
      reason: stuck ? state.op.params.blockedReason ?? "failed" : null,
    };
  }
  const row: ActivityRow = {
    ...baseRow(`op-${state.op.id}`, state.kind, "choose", state.target), opId: state.op.id, reason: state.reason,
  };
  return withTargetChoices(section, row, state.target);
}

/**
 * Builds the activities and messages section of one server: the note's
 * activities and messages there, the offered models (cached probe,
 * refreshed online; a failed probe does not block), the server's activity types (online, else
 * cached), and the note's task and opportunity there as shortcuts. A
 * failure becomes a section that offers nothing (failed).
 */
export async function buildActivitySection(
  source: ActivitySource,
  noteId: string,
  configId: string,
  creds: () => Promise<SyncCredentials>,
  online: boolean,
  noteDay: string | null,
  today: string
): Promise<ActivitySection> {
  const section: ActivitySection = { ...loadingSection(), loading: false, offline: !online, noteDay, today };
  try {
    const states = await source.attachedStates(noteId, configId);
    const c = await creds();
    const known = (reason: UnusableReason | null) => (reason === "unknown" ? null : reason);
    section.models = await Promise.all(ACTIVITY_MODELS.map(async (model) => {
      const cap = await source.capabilities.ensure(c, model, { online }).catch(() => null);
      return {
        model,
        unusable: {
          activity: known(unusableReason(cap, ["read", "activities"])),
          message: known(unusableReason(cap, ["read", "chatter"])),
        },
      };
    }));
    const types = await source.activityTypes.list(c, { online });
    section.types = types.types;
    section.typesFromCache = types.fromCache;
    for (const kind of Object.keys(KIND_MODELS) as TargetKind[]) {
      const state = await source.targetState(noteId, configId, kind);
      if (state.state === "linked") section.shortcuts.push({ kind, model: KIND_MODELS[kind], resId: state.resId });
    }
    section.rows = states.map((s) => stateRow(section, s));
  } catch (e: unknown) {
    return { ...section, failed: e instanceof Error ? e.message : String(e) };
  }
  return section;
}

/**
 * A new draft row of kind: on the note's first shortcut record when it
 * has one (its task, else its opportunity), else on the first model the
 * server can take it on; the first type of that model; the deadline of
 * that type.
 */
export function newDraftRow(section: ActivitySection, key: string, kind: AttachedKind = "activity"): ActivityRow {
  const shortcut = section.shortcuts[0] ?? null;
  const model = shortcut?.model ?? section.models.find((m) => !m.unusable[kind])?.model ?? ACTIVITY_MODELS[0];
  const row = baseRow(key, kind, "draft", {
    resModel: model, resId: null, typeId: null, deadline: null, userId: null,
  });
  if (shortcut) {
    row.records = [shortcutOption(shortcut)];
    row.recordSelection = String(shortcut.resId);
  }
  const type = typesForModel(section.types, model)[0] ?? null;
  row.typeSelection = type ? String(type.id) : DEFAULT_TYPE;
  row.deadline = deadlineFor(section, type);
  return row;
}

/** The option of a shortcut record, named by its kind (see the component's labels). */
export function shortcutOption(shortcut: Shortcut): ProjectOption {
  return { value: String(shortcut.resId), name: `#${shortcut.resId}` };
}

/**
 * Changes a row's model: its record choice is reset (to the note's own
 * record of that model when it has one), and its type to that model's
 * first when the current one does not apply to it.
 */
export function withModel(section: ActivitySection, row: ActivityRow, model: string): ActivityRow {
  const next: ActivityRow = { ...row, model, records: [], recordSelection: NO_RECORD, recordQuery: "", recordsError: null };
  const shortcut = section.shortcuts.find((s) => s.model === rowModel(next));
  if (shortcut) {
    next.records = [shortcutOption(shortcut)];
    next.recordSelection = String(shortcut.resId);
  }
  const types = rowTypes(section, next);
  if (next.typeSelection !== DEFAULT_TYPE && !types.some((t) => String(t.id) === next.typeSelection)) {
    next.typeSelection = types[0] ? String(types[0].id) : DEFAULT_TYPE;
    if (!next.deadlineEdited) next.deadline = deadlineFor(section, types[0] ?? null);
  }
  return next;
}

/** Changes a row's type; the deadline follows the type's delay until one is typed. */
export function withType(section: ActivitySection, row: ActivityRow, value: string): ActivityRow {
  const next = { ...row, typeSelection: value };
  if (!row.deadlineEdited) next.deadline = deadlineFor(section, typeById(section, value));
  return next;
}

/** Replaces a row's record options with a search, keeping the selected one and the note's own record. */
export function withRecords(section: ActivitySection, row: ActivityRow, found: RecordSearch): ActivityRow {
  const options: ProjectOption[] = found.records.map((r) => ({ value: String(r.id), name: r.name }));
  const keep = row.records.find((o) => o.value === row.recordSelection);
  if (keep && !options.some((o) => o.value === keep.value)) options.unshift(keep);
  return { ...row, records: options, recordsFromCache: found.fromCache, recordsError: found.error };
}

/** Replaces a row's user options with a search, keeping the selected one. */
export function withUsers(row: ActivityRow, found: RecordSearch): ActivityRow {
  const options: ProjectOption[] = found.records.map((r) => ({ value: String(r.id), name: r.name }));
  const keep = row.users.find((o) => o.value === row.userSelection);
  if (keep && !options.some((o) => o.value === keep.value)) options.unshift(keep);
  return { ...row, users: options };
}

/** Whether a row is edited (draft, or a creation waiting for a choice) and kept. */
export function isEditable(row: ActivityRow): boolean {
  return (row.status === "draft" || row.status === "choose") && !row.removed;
}

/**
 * The target an edited row stands for, or why it cannot be sent: a model
 * is needed; a record too, except offline or when the records come from
 * the cache after a failed search, where CHOOSE_LATER leaves it
 * "incomplete".
 */
export function rowTarget(section: ActivitySection, row: ActivityRow): ActivityTarget | { error: string } {
  const model = rowModel(row);
  const what = row.kind === "message" ? "du message" : "de l'activité";
  if (!model) return { error: `Choisissez le modèle ${what}.` };
  const later = row.recordSelection === CHOOSE_LATER;
  if (row.recordSelection === NO_RECORD || (later && !canDeferRecord(section, row))) {
    return { error: `Choisissez l'enregistrement ${what}.` };
  }
  const record = row.records.find((o) => o.value === row.recordSelection);
  const resId = later ? null : Number(row.recordSelection);
  const resName = later ? null : record?.name ?? null;
  if (row.kind === "message") {
    return { resModel: model, resId, resName, typeId: null, typeName: null, deadline: null, userId: null, userName: null };
  }
  const type = typeById(section, row.typeSelection);
  const user = row.users.find((o) => o.value === row.userSelection);
  return {
    resModel: model,
    resId,
    resName,
    typeId: type?.id ?? null,
    typeName: type?.name ?? null,
    deadline: /^\d{4}-\d{2}-\d{2}$/.test(row.deadline) ? row.deadline : null,
    userId: row.userSelection === ME ? null : Number(row.userSelection),
    userName: row.userSelection === ME ? null : user?.name ?? null,
  };
}

/** Whether a row may leave its record for later: offline, or the server's records could not be read. */
export function canDeferRecord(section: ActivitySection, row: ActivityRow): boolean {
  return section.offline || (row.recordsFromCache && !!row.recordsError);
}

/** Whether a row is a creation the user removed, which applying drops. */
function isDropped(row: ActivityRow): boolean {
  return row.removed && row.opId !== null && (row.status === "stuck" || row.status === "choose");
}

/**
 * Whether confirming the section changes something on its server: a live
 * activity to write, a creation or draft kept, or a creation to drop.
 */
export function sectionHasWork(section: ActivitySection | undefined): boolean {
  if (!section || section.loading || section.failed) return false;
  return section.rows.some((r) =>
    r.status === "linked" || r.status === "queued" || isDropped(r)
      || ((r.status === "stuck" || isEditable(r)) && !r.removed));
}

/**
 * Checks every edited row of the selected servers (see rowTarget), and
 * throws the first problem; returns, without recording anything, what
 * applying them records: setAttached for each draft and each creation
 * waiting for a choice, dropAttached for each creation the user removed.
 * Checked first, the picker's other choices are recorded only when every
 * activity can be. Each recorded row becomes "queued" (with its
 * operation), and a dropped one is forgotten, so applying the same
 * section again after a failure part way records nothing twice.
 */
export function planActivities(
  source: ActivitySource,
  noteId: string,
  configIds: string[],
  sections: Record<string, ActivitySection>
): Array<() => Promise<unknown>> {
  const planned: Array<() => Promise<unknown>> = [];
  for (const configId of configIds) {
    const section = sections[configId];
    if (!section) continue;
    if (section.loading) throw new Error(`Activités pas encore prêtes pour ${configId}.`);
    if (section.failed) continue;
    for (const row of section.rows) {
      if (row.removed) {
        if (isDropped(row)) {
          planned.push(async () => {
            await source.dropAttached(noteId, row.opId!);
            row.opId = null;
          });
        }
        continue;
      }
      if (!isEditable(row)) continue;
      const target = rowTarget(section, row);
      if ("error" in target) throw new Error(target.error);
      planned.push(async () => {
        const op = await source.setAttached(noteId, configId, row.kind, target, row.status === "choose" ? row.opId : null);
        row.status = "queued";
        row.opId = op?.id ?? row.opId;
        row.target = target;
        row.reason = null;
      });
    }
  }
  return planned;
}

/** planActivities, then records what it planned. */
export async function applyActivities(
  source: ActivitySource,
  noteId: string,
  configIds: string[],
  sections: Record<string, ActivitySection>
): Promise<void> {
  for (const run of planActivities(source, noteId, configIds, sections)) await run();
}

/**
 * Whether a new activity (or message, kind) can be added on the section's
 * server: some model offered takes it; with no kind, either.
 */
export function canAddActivity(section: ActivitySection | undefined, kind?: AttachedKind): boolean {
  if (!section || section.loading || section.failed) return false;
  return section.models.some((m) => (kind ? !m.unusable[kind] : !m.unusable.activity || !m.unusable.message));
}
