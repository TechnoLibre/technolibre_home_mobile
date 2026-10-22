import type { ServerCapability } from "./databaseService";
import type { ProjectList } from "./odoo/projectService";
import type { SyncCredentials } from "./odoo/odooRpcClient";
import { unusableReason, UnusableReason } from "./odoo/capabilityService";
import type { TaskTarget, TaskTargetState } from "./syncService";

/** Select value of a personal task (no project). */
export const NO_PROJECT = "none";
/** Select value of a creation left "incomplete" until a project is chosen. */
export const CHOOSE_LATER = "later";

export interface ProjectOption {
  /** String form of the project id, as a <select> value. */
  value: string;
  name: string;
}

/**
 * What the sync picker shows for one server. A row needs a choice when the
 * note has no live task there and no creation in progress (TaskTargetState
 * "choose", a task deleted on the server included); linked and queued
 * rows only show their state.
 */
export interface TaskTargetRow {
  loading: boolean;
  needsChoice: boolean;
  linkedResId: number | null;
  /** The task deleted on the server that a choice recreates. */
  deletedResId: number | null;
  /**
   * Why the server cannot receive a new task, shown greyed and not
   * selectable; null when it can. A server never probed ("unknown",
   * offline on first use) is not blocked: the push decides.
   */
  unusable: UnusableReason | null;
  /** Why a choice is asked again (project_missing, refused, incomplete, deleted). */
  reason: string | null;
  options: ProjectOption[];
  selection: string;
  /** Offline when the row was built. */
  offline: boolean;
  /**
   * The projects could not be read from the server (offline, or the
   * server failed): CHOOSE_LATER is offered.
   */
  canDefer: boolean;
  /** The projects come from the cache, not from the server. */
  fromCache: boolean;
  truncated: boolean;
  /** Text typed to narrow a long project list. */
  filter: string;
  error: string | null;
}

export function loadingRow(): TaskTargetRow {
  return {
    loading: true, needsChoice: false, linkedResId: null, deletedResId: null, unusable: null,
    reason: null, options: [], selection: NO_PROJECT, offline: false, canDefer: false,
    fromCache: false, truncated: false, filter: "", error: null,
  };
}

/**
 * The row of one server. For a "choose" state the options are the listed
 * projects. The target's own project is added when the list lacks it only
 * while the list may be incomplete (cached, or cut at the limit), and
 * never when it is the project found missing: a fresh full list without it
 * means it is gone, archived or hidden. The selection is the target's
 * project when offered, else NO_PROJECT.
 */
export function taskTargetRow(
  state: TaskTargetState,
  projects: ProjectList | null,
  unusable: UnusableReason | null,
  online: boolean
): TaskTargetRow {
  const row: TaskTargetRow = { ...loadingRow(), loading: false, offline: !online };
  if (state.state === "linked") return { ...row, linkedResId: state.resId };
  if (state.state !== "choose") return row;
  const options: ProjectOption[] = (projects?.projects ?? []).map((p) => ({ value: String(p.id), name: p.name }));
  const fromCache = projects?.fromCache ?? true;
  const truncated = projects?.truncated ?? false;
  const target = state.target;
  const targetValue = target?.projectId != null && state.reason !== "project_missing"
    ? String(target.projectId)
    : null;
  if (targetValue && (fromCache || truncated) && !options.some((o) => o.value === targetValue)) {
    options.push({ value: targetValue, name: target?.projectName || `#${targetValue}` });
  }
  const offered = targetValue !== null && options.some((o) => o.value === targetValue);
  return {
    ...row,
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

/** The target a row's selection stands for. */
export function targetOfSelection(row: TaskTargetRow): TaskTarget | "later" {
  if (row.selection === CHOOSE_LATER) return "later";
  if (row.selection === NO_PROJECT) return { projectId: null, projectName: null };
  const option = row.options.find((o) => o.value === row.selection);
  return { projectId: Number(row.selection), projectName: option?.name ?? null };
}

/**
 * The options whose name contains the row's filter, ignoring case and
 * accents; the selected option is always kept, so the select never shows
 * a value it has no option for.
 */
export function filteredOptions(row: TaskTargetRow): ProjectOption[] {
  const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const needle = fold(row.filter.trim());
  if (!needle) return row.options;
  return row.options.filter((o) => o.value === row.selection || fold(o.name).includes(needle));
}

/** The part of SyncService the picker reads and writes. */
export interface TaskTargetSource {
  taskTargetState(noteId: string, configId: string): Promise<TaskTargetState>;
  setTaskTarget(noteId: string, configId: string, target: TaskTarget | "later"): Promise<unknown>;
  capabilities: {
    ensure(creds: SyncCredentials, model: string, options: { online: boolean }): Promise<ServerCapability | null>;
  };
  projects: { list(creds: SyncCredentials, options: { online: boolean }): Promise<ProjectList> };
}

/** Whether a short tap must open the picker: some server waits for a project. */
export async function needsTaskTarget(source: TaskTargetSource, noteId: string, configIds: string[]): Promise<boolean> {
  for (const configId of configIds) {
    if ((await source.taskTargetState(noteId, configId)).state === "choose") return true;
  }
  return false;
}

/**
 * Builds the row of one server: the note's task state there and, where a
 * project must be chosen, the server's create right on project.task
 * (cached probe; a failed probe does not block) and its projects (online,
 * else cached). An error becomes a row that offers nothing.
 */
export async function buildTaskTargetRow(
  source: TaskTargetSource,
  noteId: string,
  configId: string,
  creds: () => Promise<SyncCredentials>,
  online: boolean
): Promise<TaskTargetRow> {
  try {
    const state = await source.taskTargetState(noteId, configId);
    if (state.state !== "choose") return taskTargetRow(state, null, null, online);
    const c = await creds();
    const cap = await source.capabilities.ensure(c, "project.task", { online }).catch(() => null);
    const projects = await source.projects.list(c, { online });
    return taskTargetRow(state, projects, unusableReason(cap, ["create"]), online);
  } catch (e: unknown) {
    return { ...loadingRow(), loading: false, offline: !online, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Records the choice of every selected server that needs one, before the
 * push: setTaskTarget with the row's selection. A selected server whose
 * row is missing, still loading, or failed to load makes it throw before
 * anything is recorded: the push would otherwise go ahead without a
 * choice. Unusable rows are skipped (they cannot be selected).
 */
export async function applyTaskTargets(
  source: TaskTargetSource,
  noteId: string,
  configIds: string[],
  rows: Record<string, TaskTargetRow>
): Promise<void> {
  for (const configId of configIds) {
    const row = rows[configId];
    if (!row || row.loading) throw new Error(`Choix du projet pas encore prêt pour ${configId}.`);
    if (row.error && !row.needsChoice) throw new Error(`${configId} : ${row.error}`);
  }
  for (const configId of configIds) {
    const row = rows[configId];
    if (row.needsChoice && !row.unusable) {
      await source.setTaskTarget(noteId, configId, targetOfSelection(row));
    }
  }
}
