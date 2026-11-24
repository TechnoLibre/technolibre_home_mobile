import type { Note, NoteEntry, NoteEntryDateParams } from "../models/note";

/**
 * The fields of a note a remote record mirrors, each in a form both sides
 * compare: title (spaces collapsed); text (the paragraphs the user wrote,
 * one per line: the lines the app writes from other entries and its
 * marker left out); media (those app lines: they change the record's text
 * but are rebuilt from entries, never read back); tags (names, sorted);
 * date ("YYYY-MM-DD" of the first date entry, null for none); done,
 * archived, pinned.
 */
export type MirrorField = "title" | "text" | "media" | "tags" | "date" | "done" | "archived" | "pinned";
export type MirrorValues = Partial<Record<MirrorField, any>>;

/** What a kind of record mirrors, two ways unless listed in PULL_ONLY. */
export type MirrorKind = "task" | "lead" | "invoice" | "activity";

/**
 * The values of a link's last exchange: the note's (local) and the
 * record's (remote), field by field. A field changed on one side since
 * is that side's change; on both, a conflict.
 */
export interface MirrorBase {
  local: MirrorValues;
  remote: MirrorValues;
}

/** The fields each kind mirrors; a task's done needs Odoo 17+ (state). */
export function mirrorFields(kind: MirrorKind, odooVersion: number): MirrorField[] {
  if (kind === "task") {
    return ["title", "text", "media", "tags", "date", ...(odooVersion >= 17 ? ["done" as const] : []), "archived", "pinned"];
  }
  if (kind === "lead") return ["title", "text", "media", "tags", "date"];
  if (kind === "invoice") return ["title", "text", "media"];
  return ["title", "text", "media", "date"];
}

/** Fields a kind brings back from the server but never sends: an activity's deadline is chosen at its creation. */
export const PULL_ONLY: Partial<Record<MirrorKind, MirrorField[]>> = { activity: ["date"] };

/** Fields a kind sends but never brings back: the app lines, rebuilt from the note's entries. */
export const PUSH_ONLY: Partial<Record<MirrorKind, MirrorField[]>> = {
  task: ["media"], lead: ["media"], invoice: ["media"], activity: ["media"],
};

/** Lines the app writes itself from entries (media, date, position) or as its marker. */
const APP_LINE = /^(📅 Date :|📍 Géolocalisation|🎙️ Enregistrement audio|📷 Photo|🎥 Vidéo)|erplibre-mobile:/u;

export function isAppLine(line: string): boolean {
  return APP_LINE.test(line);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * The paragraphs of an HTML text, as plain text: a block (p, div, li,
 * h1-h6) or a line break ends one; tags are dropped, entities decoded,
 * spaces collapsed; empty ones are left out.
 */
export function htmlToParagraphs(html: string | false | null | undefined): string[] {
  if (!html) return [];
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .split("\n")
    .map((line) => decodeEntities(line).replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** The text form of paragraphs: the user's, one per line (app lines and the marker left out). */
export function textOf(paragraphs: string[]): string {
  return paragraphs.filter((p) => !isAppLine(p)).join("\n");
}

/** The app lines of paragraphs (media, date, position), one per line, the marker left out. */
export function mediaOf(paragraphs: string[]): string {
  return paragraphs.filter((p) => isAppLine(p) && !p.includes("erplibre-mobile:")).join("\n");
}

/** A title as both sides compare it: spaces collapsed, trimmed. */
export function titleOf(title: string | null | undefined): string {
  return String(title ?? "").replace(/\s+/g, " ").trim();
}

/** "YYYY-MM-DD" in the device's time zone of an ISO date-time, or null. */
function localDayOfIso(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The day of a server date or date-time: a Date ("YYYY-MM-DD") as is; a
 * Datetime ("YYYY-MM-DD HH:MM:SS", UTC) in the device's time zone; false
 * or empty as none.
 */
export function remoteDay(value: string | false | null | undefined): string | null {
  if (!value) return null;
  const text = String(value);
  if (text.length <= 10) return text;
  return localDayOfIso(`${text.replace(" ", "T")}Z`);
}

/** The note's mirrored values; html renders its entries as the app sends them. */
export function localValues(note: Note, html: string): MirrorValues {
  const first = note.entries.find((e) => e.type === "date");
  const paragraphs = htmlToParagraphs(html);
  return {
    title: titleOf(note.title),
    text: textOf(paragraphs),
    media: mediaOf(paragraphs),
    tags: [...note.tags].sort(),
    date: localDayOfIso(first ? (first.params as NoteEntryDateParams).date : null),
    done: !!note.done,
    archived: !!note.archived,
    pinned: !!note.pinned,
  };
}

/**
 * The mirrored values of a record body sent as HTML with the title as its
 * first paragraph, in bold (an invoice's narration): the title, and the
 * text after it.
 */
export function titledValues(html: string | false | null | undefined): { title: string | null; text: string; media: string } {
  const raw = String(html || "");
  const bold = raw.match(/^\s*<p>\s*<b>([\s\S]*?)<\/b>\s*<\/p>/i);
  const rest = htmlToParagraphs(bold ? raw.slice(bold[0].length) : raw);
  return {
    title: bold ? titleOf(htmlToParagraphs(bold[1]).join(" ")) : null,
    text: textOf(rest),
    media: mediaOf(rest),
  };
}

function same(a: any, b: any): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export interface MergeResult {
  /** Changed on the server only: the note takes them. */
  apply: MirrorValues;
  /** Changed in the app only: the next push sends them. */
  push: MirrorField[];
  /** Changed on both sides to different values: the user chooses. */
  conflicts: Partial<Record<MirrorField, { mine: any; theirs: any }>>;
  /** Changed on both sides to the same value: nothing to do but the base. */
  agreed: MirrorField[];
}

/**
 * The three-way merge of fields (see MergeResult). A field in pullOnly
 * never counts as changed in the app (a change of the server's is taken,
 * the app's is never sent); one in pushOnly never counts as changed on
 * the server (the app's goes out, what the server holds is not read back).
 */
export function mergeFields(
  fields: MirrorField[],
  base: MirrorBase,
  local: MirrorValues,
  remote: MirrorValues,
  pullOnly: MirrorField[] = [],
  pushOnly: MirrorField[] = []
): MergeResult {
  const result: MergeResult = { apply: {}, push: [], conflicts: {}, agreed: [] };
  for (const f of fields) {
    const localChanged = !pullOnly.includes(f) && !same(local[f], base.local[f]);
    const remoteChanged = !pushOnly.includes(f) && !same(remote[f], base.remote[f]);
    if (remoteChanged && !localChanged) result.apply[f] = remote[f];
    else if (localChanged && !remoteChanged) result.push.push(f);
    else if (localChanged && remoteChanged) {
      if (same(local[f], remote[f])) result.agreed.push(f);
      else result.conflicts[f] = { mine: local[f], theirs: remote[f] };
    }
  }
  return result;
}

/** The fields whose local value differs from the base: what a push must send. */
export function changedFields(fields: MirrorField[], base: MirrorBase, local: MirrorValues): MirrorField[] {
  return fields.filter((f) => !same(local[f], base.local[f]));
}

/**
 * The note with values applied: the title; the text replacing the note's
 * text entries (one per line, lines the app writes itself from other
 * entries skipped), placed where the first text entry was: a line equal
 * to an existing entry's text keeps that entry (its id, translation,
 * read-only flag), the others are new; the tags; the day of the first
 * date entry (created when missing, removed for none); done, archived,
 * pinned. newId makes the ids of new entries.
 */
export function applyValues(note: Note, values: MirrorValues, newId: () => string): Note {
  const next: Note = { ...note, entries: [...note.entries] };
  if ("title" in values) next.title = values.title ?? "";
  if ("tags" in values) next.tags = [...(values.tags ?? [])];
  if ("done" in values) next.done = !!values.done;
  if ("archived" in values) next.archived = !!values.archived;
  if ("pinned" in values) next.pinned = !!values.pinned;
  if ("text" in values) {
    const lines = String(values.text ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !isAppLine(l));
    const at = next.entries.findIndex((e) => e.type === "text");
    const kept = next.entries.filter((e) => e.type !== "text");
    const unused = next.entries.filter((e) => e.type === "text");
    const texts: NoteEntry[] = lines.map((text) => {
      const i = unused.findIndex((e) => String((e.params as any).text ?? "").replace(/\s+/g, " ").trim() === text);
      if (i >= 0) return unused.splice(i, 1)[0];
      return { id: newId(), type: "text", params: { text, readonly: false } };
    });
    const insertAt = at < 0 ? kept.length : next.entries.slice(0, at).filter((e) => e.type !== "text").length;
    next.entries = [...kept.slice(0, insertAt), ...texts, ...kept.slice(insertAt)];
  }
  if ("date" in values) {
    const index = next.entries.findIndex((e) => e.type === "date");
    const day: string | null = values.date ?? null;
    if (day === null) {
      if (index >= 0) next.entries.splice(index, 1);
    } else {
      const current = index >= 0 ? (next.entries[index].params as NoteEntryDateParams).date : null;
      if (localDayOfIso(current) !== day) {
        const date = new Date(`${day}T09:00:00`).toISOString();
        if (index >= 0) next.entries[index] = { ...next.entries[index], params: { date } };
        else next.entries.unshift({ id: newId(), type: "date", params: { date } });
      }
    }
  }
  return next;
}
