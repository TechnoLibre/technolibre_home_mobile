import type { ServerCapability } from "./databaseService";
import type { ProjectList } from "./odoo/projectService";
import type { RecordSearch } from "./odoo/recordSearchService";
import type { SyncCredentials } from "./odoo/odooRpcClient";
import { unusableReason, UnusableReason } from "./odoo/capabilityService";
import type {
  AttachedState, InvoiceLine, InvoiceMoveType, InvoiceTarget, LeadTarget, Target, TargetKind, TargetState, TaskTarget,
} from "./syncService";
import { fieldValue, InvoiceForm, localDatetimeText } from "./odoo/invoiceForm";

/** Select value of no project (a personal task) or no partner. */
export const NO_PROJECT = "none";
export const NO_PARTNER = "none";
/** Select value of a creation left "incomplete" until a choice is made. */
export const CHOOSE_LATER = "later";

/** Kinds the picker offers, in display order. */
export const PICKER_KINDS: TargetKind[] = ["task", "lead", "invoice"];

/** Model each kind creates, probed for the create right. */
const KIND_MODELS: Record<TargetKind, string> = { task: "project.task", lead: "crm.lead", invoice: "account.move" };

/** Link select value of an invoice tied to nothing. */
export const NO_TIE = "none";

/** One line of a draft invoice as typed: label, quantity, unit price, product. */
export interface InvoiceLineDraft {
  key: string;
  name: string;
  quantity: string;
  price: string;
  /** Product id as a select value; "" for none. */
  productSelection: string;
  products: ProjectOption[];
  productQuery: string;
}

/**
 * The invoice part of an invoice row: its type, date, reference, lines,
 * the server's extra required fields (form, null while loading) with the
 * values typed for them (a many2one: the chosen id, its choices in
 * extraOptions), and the note's own record it is tied to (tie: NO_TIE,
 * "task" or "lead"; ties: those offered).
 */
export interface InvoiceDraft {
  moveType: InvoiceMoveType;
  invoiceDate: string;
  ref: string;
  lines: InvoiceLineDraft[];
  form: InvoiceForm | null;
  extraValues: Record<string, string>;
  extraOptions: Record<string, ProjectOption[]>;
  extraQueries: Record<string, string>;
  tie: string;
  ties: Array<"task" | "lead">;
}

/** Bumped by each new invoice line, for its key. */
let invoiceLines = 0;

/** An empty invoice line, quantity 1. */
export function newInvoiceLine(): InvoiceLineDraft {
  return { key: `line-${++invoiceLines}`, name: "", quantity: "1", price: "", productSelection: "", products: [], productQuery: "" };
}

export interface ProjectOption {
  /** String form of the record id, as a <select> value. */
  value: string;
  name: string;
}

/**
 * What the sync picker shows for one kind of target on one server. A row
 * needs a choice when the note has no live record of that kind there and
 * no creation in progress (TargetState "choose", a record deleted on the
 * server included); linked and queued rows only show their state, and
 * are always pushed. checked: the kind is sent to this server.
 *
 * options / selection / filter hold the projects of a task, or the
 * partners found for a lead (query: the text searched); revenue is the
 * lead's expected revenue as typed.
 */
export interface TargetRow {
  kind: TargetKind;
  loading: boolean;
  checked: boolean;
  needsChoice: boolean;
  linkedResId: number | null;
  queued: boolean;
  /**
   * A queued creation that failed or is blocked: the user may uncheck it
   * to drop it, rather than wait for retries that may never succeed.
   */
  droppable: boolean;
  /** The record deleted on the server that a choice recreates. */
  deletedResId: number | null;
  /**
   * Why the server cannot receive a new record of this kind, shown greyed
   * and not selectable; null when it can. A server never probed
   * ("unknown", offline on first use) is not blocked: the push decides.
   */
  unusable: UnusableReason | null;
  /** Why a choice is asked again (project_missing, partner_missing, refused, incomplete, deleted). */
  reason: string | null;
  options: ProjectOption[];
  selection: string;
  /** Offline when the row was built. */
  offline: boolean;
  /**
   * The choices could not be read from the server (offline, or the
   * server failed): CHOOSE_LATER is offered.
   */
  canDefer: boolean;
  /** The choices come from the cache, not from the server. */
  fromCache: boolean;
  truncated: boolean;
  /** Text typed to narrow a long project list. */
  filter: string;
  /** Text searched for a lead's partner. */
  query: string;
  /** A lead's expected revenue as typed; empty for none. */
  revenue: string;
  /** Why the choices came from the cache: the server's error, shown as a notice. */
  error: string | null;
  /** Why the row could not be built at all; such a row offers nothing. */
  failed: string | null;
  /** An invoice row's own choices; null for the other kinds. */
  invoice: InvoiceDraft | null;
}

/** Back-compatible name of a task's row. */
export type TaskTargetRow = TargetRow;

export function loadingRow(kind: TargetKind = "task"): TargetRow {
  return {
    kind, loading: true, checked: false, needsChoice: false, linkedResId: null, queued: false, droppable: false,
    deletedResId: null, unusable: null, reason: null, options: [],
    selection: kind === "task" ? NO_PROJECT : NO_PARTNER, offline: false, canDefer: false,
    fromCache: false, truncated: false, filter: "", query: "", revenue: "", error: null, failed: null,
    invoice: null,
  };
}

/** The row of a linked or queued kind: nothing to choose. */
function stateRow(kind: TargetKind, state: TargetState, online: boolean): TargetRow | null {
  const row: TargetRow = { ...loadingRow(kind), loading: false, offline: !online };
  if (state.state === "linked") return { ...row, checked: true, linkedResId: state.resId };
  if (state.state === "queued") {
    const stuck = state.op.status === "failed" || state.op.status === "blocked";
    return { ...row, checked: true, queued: true, droppable: stuck, reason: stuck ? state.op.params.blockedReason ?? "failed" : null };
  }
  return null;
}

/**
 * The task row of one server. For a "choose" state the options are the
 * listed projects. The target's own project is added when the list lacks
 * it only while the list may be incomplete (cached, or cut at the limit),
 * and never when it is the project found missing: a fresh full list
 * without it means it is gone, archived or hidden. The selection is the
 * target's project when offered, else NO_PROJECT.
 */
export function taskTargetRow(
  state: TargetState,
  projects: ProjectList | null,
  unusable: UnusableReason | null,
  online: boolean
): TargetRow {
  const done = stateRow("task", state, online);
  if (done || state.state !== "choose") return done ?? { ...loadingRow("task"), loading: false, offline: !online };
  const options: ProjectOption[] = (projects?.projects ?? []).map((p) => ({ value: String(p.id), name: p.name }));
  const fromCache = projects?.fromCache ?? true;
  const truncated = projects?.truncated ?? false;
  const target = state.target as TaskTarget | null;
  const targetValue = target?.projectId != null && state.reason !== "project_missing"
    ? String(target.projectId)
    : null;
  if (targetValue && (fromCache || truncated) && !options.some((o) => o.value === targetValue)) {
    options.push({ value: targetValue, name: target?.projectName || `#${targetValue}` });
  }
  const offered = targetValue !== null && options.some((o) => o.value === targetValue);
  return {
    ...loadingRow("task"),
    loading: false,
    offline: !online,
    needsChoice: true,
    deletedResId: state.deletedResId ?? null,
    unusable: unusable === "unknown" ? null : unusable,
    reason: state.reason,
    options,
    selection: offered ? targetValue! : NO_PROJECT,
    canDefer: !online || (fromCache && !!projects?.error),
    fromCache,
    truncated,
    error: projects?.error ?? null,
  };
}

/**
 * The lead row of one server. For a "choose" state the options are the
 * partners found (recent ones before any search), plus the target's own
 * partner when not found and not the one found missing; the selection is
 * that partner, else NO_PARTNER; revenue is the target's.
 */
export function leadTargetRow(
  state: TargetState,
  partners: RecordSearch | null,
  unusable: UnusableReason | null,
  online: boolean
): TargetRow {
  const done = stateRow("lead", state, online);
  if (done || state.state !== "choose") return done ?? { ...loadingRow("lead"), loading: false, offline: !online };
  const target = state.target as LeadTarget | null;
  const options: ProjectOption[] = (partners?.records ?? []).map((p) => ({ value: String(p.id), name: p.name }));
  const targetValue = target?.partnerId != null && state.reason !== "partner_missing"
    ? String(target.partnerId)
    : null;
  if (targetValue && !options.some((o) => o.value === targetValue)) {
    options.unshift({ value: targetValue, name: target?.partnerName || `#${targetValue}` });
  }
  const fromCache = partners?.fromCache ?? true;
  return {
    ...loadingRow("lead"),
    loading: false,
    offline: !online,
    needsChoice: true,
    deletedResId: state.deletedResId ?? null,
    unusable: unusable === "unknown" ? null : unusable,
    reason: state.reason,
    options,
    selection: targetValue ?? NO_PARTNER,
    revenue: target?.expectedRevenue != null ? String(target.expectedRevenue) : "",
    canDefer: !online || (fromCache && !!partners?.error),
    fromCache,
    error: partners?.error ?? null,
  };
}

/**
 * The invoice row of one server. Its partner is chosen as a lead's (see
 * leadTargetRow); a "choose" state brings back the type, date, reference,
 * lines, extra values and tie of its target, else the row starts as a
 * customer invoice with one empty line, tied to the first of ties (the
 * note's task or opportunity on this server, linked or being created). A
 * kept many2one extra value is offered under its kept name.
 */
export function invoiceTargetRow(
  state: TargetState,
  partners: RecordSearch | null,
  form: InvoiceForm | null,
  unusable: UnusableReason | null,
  online: boolean,
  ties: Array<"task" | "lead"> = []
): TargetRow {
  const done = stateRow("invoice", state, online);
  if (done || state.state !== "choose") return done ?? { ...loadingRow("invoice"), loading: false, offline: !online };
  const asLead = leadTargetRow({ ...state, target: state.target as LeadTarget | null }, partners, unusable, online);
  const target = state.op && "moveType" in (state.op.params ?? {}) ? state.target as InvoiceTarget | null : null;
  const lines: InvoiceLineDraft[] = (target?.lines ?? []).map((l: InvoiceLine) => ({
    ...newInvoiceLine(),
    name: l.name,
    quantity: String(l.quantity),
    price: l.priceUnit != null ? String(l.priceUnit) : "",
    productSelection: l.productId != null ? String(l.productId) : "",
    products: l.productId != null ? [{ value: String(l.productId), name: l.productName || `#${l.productId}` }] : [],
  }));
  const tie = target ? target.linkKind ?? NO_TIE : ties[0] ?? NO_TIE;
  const fieldsByName = new Map((form?.fields ?? []).map((f) => [f.name, f]));
  const extraValues: Record<string, string> = {};
  const extraOptions: Record<string, ProjectOption[]> = {};
  for (const [name, v] of Object.entries(target?.extra ?? {})) {
    const field = fieldsByName.get(name);
    extraValues[name] = typeof v === "boolean" ? (v ? "1" : "")
      : field?.type === "datetime" ? localDatetimeText(String(v)) : String(v);
    // A kept many2one is offered under its name, so its select shows it
    if (field?.type === "many2one") extraOptions[name] = [{ value: String(v), name: target?.extraNames?.[name] || `#${v}` }];
  }
  return {
    ...asLead,
    kind: "invoice",
    revenue: "",
    invoice: {
      moveType: target?.moveType ?? "out_invoice",
      invoiceDate: target?.invoiceDate ?? "",
      ref: target?.ref ?? "",
      lines: lines.length > 0 ? lines : [newInvoiceLine()],
      form,
      extraValues,
      extraOptions,
      extraQueries: {},
      tie: tie !== NO_TIE && !ties.includes(tie as "task" | "lead") ? NO_TIE : tie,
      ties,
    },
  };
}

/**
 * The invoice an invoice row stands for, or why it cannot be sent: a line
 * needs a label once anything of it is typed (a line left empty is
 * skipped), a quantity and a price that parse (see parseRevenue); every
 * extra field must be filled (see fieldValue).
 */
export function invoiceTargetOf(row: TargetRow): InvoiceTarget | { error: string } {
  const inv = row.invoice;
  if (!inv || !inv.form) return { error: "Le formulaire de la facture est encore en chargement." };
  const lines: InvoiceLine[] = [];
  for (const [i, l] of inv.lines.entries()) {
    if (!l.name.trim() && !l.price.trim() && !l.productSelection) continue;
    if (!l.name.trim()) return { error: `Ligne ${i + 1} de la facture : libellé obligatoire.` };
    const quantity = parseRevenue(l.quantity);
    // No price typed: the server takes the product's (0 without a product)
    const priceUnit = l.price.trim() ? parseRevenue(l.price) : null;
    if (quantity === null || (l.price.trim() && priceUnit === null)) {
      return { error: `Ligne ${i + 1} de la facture : quantité ou prix invalide.` };
    }
    const product = l.products.find((o) => o.value === l.productSelection);
    lines.push({
      name: l.name.trim(), quantity, priceUnit,
      productId: l.productSelection ? Number(l.productSelection) : null,
      productName: product?.name ?? null,
    });
  }
  const extra: Record<string, any> = {};
  const extraNames: Record<string, string> = {};
  for (const field of inv.form?.fields ?? []) {
    const value = fieldValue(field, inv.extraValues[field.name] ?? "");
    if ("error" in value) return { error: value.error };
    extra[field.name] = value.value;
    const option = (inv.extraOptions[field.name] ?? []).find((o) => o.value === inv.extraValues[field.name]);
    if (field.type === "many2one" && option) extraNames[field.name] = option.name;
  }
  const option = row.options.find((o) => o.value === row.selection);
  return {
    moveType: inv.moveType,
    partnerId: row.selection === NO_PARTNER || row.selection === CHOOSE_LATER ? null : Number(row.selection),
    partnerName: row.selection === NO_PARTNER ? null : option?.name ?? null,
    invoiceDate: /^\d{4}-\d{2}-\d{2}$/.test(inv.invoiceDate) ? inv.invoiceDate : null,
    ref: inv.ref.trim() || null,
    lines,
    extra,
    extraNames,
    linkKind: inv.tie === "task" || inv.tie === "lead" ? inv.tie : null,
  };
}

/**
 * What an invoice left for later keeps of its draft: all of it, partner
 * excepted (the choice left for later), when it is valid; else its type
 * only, so the form comes back for that type.
 */
function invoiceLaterParams(row: TargetRow): Record<string, any> {
  const draft = invoiceTargetOf({ ...row, selection: NO_PARTNER });
  if ("error" in draft) return { moveType: row.invoice?.moveType ?? "out_invoice" };
  return { ...draft, partnerId: null, partnerName: null };
}

/** Replaces a lead row's partners with a new search, keeping the selected one. */
export function withPartners(row: TargetRow, partners: RecordSearch): TargetRow {
  const options: ProjectOption[] = partners.records.map((p) => ({ value: String(p.id), name: p.name }));
  const selected = row.options.find((o) => o.value === row.selection);
  if (selected && !options.some((o) => o.value === selected.value)) options.unshift(selected);
  return {
    ...row,
    options,
    fromCache: partners.fromCache,
    error: partners.error,
    canDefer: row.offline || (partners.fromCache && !!partners.error),
  };
}

/**
 * Expected revenue typed by the user: a number at least 0. Spaces are
 * ignored; with both "," and ".", the last one is the decimal separator
 * and the other groups thousands ("1,500.50", "1.500,50"); a separator
 * repeated alone groups thousands ("1.500.000"); a single one is decimal.
 * Anything else (empty included) is none.
 */
export function parseRevenue(text: string): number | null {
  let cleaned = text.trim().replace(/[\s\u00a0\u202f]/g, "");
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    const thousands = lastComma > lastDot ? "." : ",";
    cleaned = cleaned.split(thousands).join("").replace(",", ".");
  } else {
    const sep = lastComma >= 0 ? "," : ".";
    const count = cleaned.split(sep).length - 1;
    cleaned = count > 1 ? cleaned.split(sep).join("") : cleaned.replace(",", ".");
  }
  const value = Number(cleaned);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** The target a row's selection stands for (an invoice row's must be valid, see invoiceTargetOf). */
export function targetOfSelection(row: TargetRow): Target | "later" {
  if (row.selection === CHOOSE_LATER) return "later";
  if (row.kind === "invoice") {
    const invoice = invoiceTargetOf(row);
    if ("error" in invoice) throw new Error(invoice.error);
    return invoice;
  }
  const option = row.options.find((o) => o.value === row.selection);
  if (row.kind === "task") {
    if (row.selection === NO_PROJECT) return { projectId: null, projectName: null };
    return { projectId: Number(row.selection), projectName: option?.name ?? null };
  }
  return {
    partnerId: row.selection === NO_PARTNER ? null : Number(row.selection),
    partnerName: row.selection === NO_PARTNER ? null : option?.name ?? null,
    expectedRevenue: parseRevenue(row.revenue),
  };
}

/**
 * The options whose name contains the row's filter, ignoring case and
 * accents; the selected option is always kept, so the select never shows
 * a value it has no option for.
 */
export function filteredOptions(row: TargetRow): ProjectOption[] {
  const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const needle = fold(row.filter.trim());
  if (!needle) return row.options;
  return row.options.filter((o) => o.value === row.selection || fold(o.name).includes(needle));
}

/** The part of SyncService the picker reads and writes. */
export interface TargetSource {
  targetState(noteId: string, configId: string, kind: TargetKind): Promise<TargetState>;
  setTarget(
    noteId: string,
    configId: string,
    kind: TargetKind,
    target: Target | "later",
    laterParams?: Record<string, any>
  ): Promise<unknown>;
  dropTarget(noteId: string, configId: string, kind: TargetKind): Promise<void>;
  /** The note's activities and messages there, when the source has them (see AttachedState). */
  attachedStates?(noteId: string, configId: string): Promise<AttachedState[]>;
  lastKinds(configId: string): Promise<TargetKind[]>;
  setLastKinds(configId: string, kinds: TargetKind[]): Promise<void>;
  capabilities: {
    ensure(creds: SyncCredentials, model: string, options: { online: boolean }): Promise<ServerCapability | null>;
  };
  projects: { list(creds: SyncCredentials, options: { online: boolean }): Promise<ProjectList> };
  partners: { search(creds: SyncCredentials, text: string, options: { online: boolean }): Promise<RecordSearch> };
  invoiceForms: {
    load(creds: SyncCredentials, moveType: InvoiceMoveType, options: { online: boolean }): Promise<InvoiceForm>;
  };
}

/** Back-compatible name of the picker's source. */
export type TaskTargetSource = TargetSource;

/** Whether a state is something the note already has on the server. */
const isSettled = (s: TargetState | AttachedState) => s.state === "linked" || s.state === "queued";

/** The note's activities and messages on a server, none when the source has none. */
async function activitiesOf(source: TargetSource, noteId: string, configId: string): Promise<AttachedState[]> {
  return source.attachedStates ? source.attachedStates(noteId, configId) : [];
}

/**
 * Whether a short tap must open the picker for these servers: one where
 * the note has no record, no activity, no message and no creation of any
 * kind, or one where a creation waits for a new choice (blocked for a
 * reason to choose again, left for later, or its record deleted on the
 * server), an activity's or a message's included.
 */
export async function needsTaskTarget(source: TargetSource, noteId: string, configIds: string[]): Promise<boolean> {
  for (const configId of configIds) {
    const states = await Promise.all(PICKER_KINDS.map((k) => source.targetState(noteId, configId, k)));
    const activities = await activitiesOf(source, noteId, configId);
    if (!states.some(isSettled) && !activities.some(isSettled)) return true;
    if (states.some((s) => s.state === "choose" && (s.op !== null || s.reason === "deleted"))) return true;
    if (activities.some((a) => a.state === "choose")) return true;
  }
  return false;
}

/**
 * Builds the rows of one server, one per kind: the note's state for that
 * kind and, where a choice is needed, the server's create right on the
 * kind's model (cached probe; a failed probe does not block) and its
 * choices: projects (online, else cached) or recent partners. A kind
 * waiting for a new choice is checked; a kind never chosen is checked
 * only when the note has nothing on this server (no record, activity,
 * message or creation), as the server's last checked kinds say. A failure becomes a
 * row that offers nothing (failed).
 */
export async function buildTargetRows(
  source: TargetSource,
  noteId: string,
  configId: string,
  creds: () => Promise<SyncCredentials>,
  online: boolean
): Promise<Record<TargetKind, TargetRow>> {
  const rows = {} as Record<TargetKind, TargetRow>;
  let states: TargetState[];
  try {
    states = await Promise.all(PICKER_KINDS.map((k) => source.targetState(noteId, configId, k)));
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    for (const kind of PICKER_KINDS) rows[kind] = { ...loadingRow(kind), loading: false, offline: !online, failed: error };
    return rows;
  }
  const bare = !states.some(isSettled)
    && !(await activitiesOf(source, noteId, configId).catch(() => [])).some(isSettled);
  const defaults = bare ? await source.lastKinds(configId) : [];
  for (const [i, kind] of PICKER_KINDS.entries()) {
    const state = states[i];
    try {
      if (state.state !== "choose") {
        rows[kind] = kind === "task" ? taskTargetRow(state, null, null, online)
          : kind === "lead" ? leadTargetRow(state, null, null, online)
          : invoiceTargetRow(state, null, null, null, online);
        continue;
      }
      const c = await creds();
      const cap = await source.capabilities.ensure(c, KIND_MODELS[kind], { online }).catch(() => null);
      const unusable = unusableReason(cap, ["create"]);
      let row: TargetRow;
      if (kind === "task") row = taskTargetRow(state, await source.projects.list(c, { online }), unusable, online);
      else if (kind === "lead") row = leadTargetRow(state, await source.partners.search(c, "", { online }), unusable, online);
      else {
        const moveType = (state.target as InvoiceTarget | null)?.moveType ?? "out_invoice";
        // A task or opportunity the note has, or is creating, on this server
        const ties = (["task", "lead"] as const).filter((k) => {
          const s = states[PICKER_KINDS.indexOf(k)];
          return s.state === "linked" || s.state === "queued" || (s.state === "choose" && s.op !== null);
        });
        row = invoiceTargetRow(
          state, await source.partners.search(c, "", { online }),
          await source.invoiceForms.load(c, moveType, { online }), unusable, online, [...ties]
        );
      }
      const waiting = state.op !== null || state.reason === "deleted";
      row.checked = !row.unusable && (waiting || defaults.includes(kind));
      rows[kind] = row;
    } catch (e: unknown) {
      rows[kind] = { ...loadingRow(kind), loading: false, offline: !online, failed: e instanceof Error ? e.message : String(e) };
    }
  }
  return rows;
}

/**
 * Whether a server's rows let it receive anything: a kind checked or
 * settled, none failing, or activities to send (hasActivityWork).
 */
export function serverUsable(rows: Record<TargetKind, TargetRow> | undefined, hasActivityWork = false): boolean {
  if (hasActivityWork) return true;
  if (!rows) return false;
  const all = PICKER_KINDS.map((k) => rows[k]);
  if (all.some((r) => r.linkedResId !== null || r.queued)) return true;
  return all.some((r) => r.needsChoice && !r.unusable && !r.failed);
}

/**
 * Records the choices of every selected server before the push:
 * setTarget for each checked kind that needs a choice (a lead left for
 * later keeps its typed revenue), dropTarget for a kind left unchecked
 * while it waited (reason set: blocked, left for later, deleted on the
 * server), unusable ones included — the server no longer lets it be
 * sent, and it would block every tap — or a queued creation unchecked
 * after it failed or blocked (droppable), and, for a server where the note had
 * nothing, the checked kinds (when any) as its default for the next note. A selected
 * server whose rows are missing or still loading, or with no kind checked
 * (failed and unusable rows never are) and no activity to send
 * (hasActivityWork), makes it throw before anything is recorded: the push
 * would otherwise go ahead without a choice.
 */
export async function applyTaskTargets(
  source: TargetSource,
  noteId: string,
  configIds: string[],
  targets: Record<string, Record<TargetKind, TargetRow>>,
  hasActivityWork: (configId: string) => boolean = () => false
): Promise<void> {
  for (const configId of configIds) {
    const rows = targets[configId];
    if (!rows) throw new Error(`Choix de la cible pas encore prêt pour ${configId}.`);
    for (const kind of PICKER_KINDS) {
      const row = rows[kind];
      if (!row || row.loading) throw new Error(`Choix de la cible pas encore prêt pour ${configId}.`);
    }
    if (!PICKER_KINDS.some((k) => rows[k].checked) && !hasActivityWork(configId)) {
      throw new Error(`Aucune cible cochée pour ${configId}.`);
    }
    const invoice = rows.invoice;
    if (invoice.checked && invoice.needsChoice && !invoice.unusable && invoice.selection !== CHOOSE_LATER) {
      const checked = invoiceTargetOf(invoice);
      if ("error" in checked) throw new Error(checked.error);
    }
  }
  for (const configId of configIds) {
    const rows = targets[configId];
    const bare = !PICKER_KINDS.some((k) => rows[k].linkedResId !== null || rows[k].queued || rows[k].reason !== null);
    const kinds = PICKER_KINDS.filter((k) => rows[k].checked);
    for (const kind of PICKER_KINDS) {
      const row = rows[kind];
      if (row.droppable && !row.checked) {
        await source.dropTarget(noteId, configId, kind);
        continue;
      }
      if (!row.needsChoice) continue;
      if (row.checked && !row.unusable) {
        const target = targetOfSelection(row);
        const laterParams = kind === "lead" ? { expectedRevenue: parseRevenue(row.revenue) }
          : kind === "invoice" ? invoiceLaterParams(row)
          : {};
        if (target === "later") await source.setTarget(noteId, configId, kind, target, laterParams);
        else await source.setTarget(noteId, configId, kind, target);
      } else if (row.reason !== null) {
        await source.dropTarget(noteId, configId, kind);
      }
    }
    // Nothing checked (activities only): the server's default kinds stay
    if (bare && kinds.length > 0) await source.setLastKinds(configId, kinds);
  }
}
