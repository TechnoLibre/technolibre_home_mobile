import type { Note, NoteEntry } from "../../models/note";

/** The note fields an editor and a pull can both change, the entries aside. */
const FIELDS = ["title", "done", "archived", "pinned", "priority", "tags"] as const;

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The note an editor saves when the stored one may have changed under it
 * (a pull, while the editor held the note): since is the note as the
 * editor last read or wrote it, mine the editor's, stored the one saved
 * now. A field the editor did not change since takes the stored value; one
 * it changed keeps its own. Entries go the same way one by one, by id: an
 * entry the editor left as it was takes the stored version, or goes when
 * the stored note dropped it; one the editor changed, added or kept stays
 * as it has it; one only the stored note added comes in after the entry
 * that precedes it there. The editor's entries keep their objects, so an
 * entry being typed in is the same one.
 */
export function mergeLocalEdit(since: Note, mine: Note, stored: Note): Note {
	const merged: Note = { ...mine };
	for (const field of FIELDS) {
		if (same(mine[field], since[field]) && !same(stored[field], since[field])) {
			(merged as any)[field] = stored[field];
		}
	}
	merged.entries = mergeEntries(since.entries ?? [], mine.entries ?? [], stored.entries ?? []);
	return merged;
}

function mergeEntries(since: NoteEntry[], mine: NoteEntry[], stored: NoteEntry[]): NoteEntry[] {
	const sinceById = new Map(since.map((e) => [e.id, e]));
	const storedById = new Map(stored.map((e) => [e.id, e]));
	const mineIds = new Set(mine.map((e) => e.id));
	const result: NoteEntry[] = [];
	for (const entry of mine) {
		const before = sinceById.get(entry.id);
		const theirs = storedById.get(entry.id);
		const untouched = before !== undefined && same(entry, before);
		if (untouched && theirs === undefined) continue;
		result.push(untouched && theirs !== undefined && !same(theirs, before) ? theirs : entry);
	}
	// Entries only the stored note added, each after the one before it there
	stored.forEach((entry, index) => {
		if (mineIds.has(entry.id) || sinceById.has(entry.id)) return;
		const previous = stored.slice(0, index).reverse().find((e) => result.some((r) => r.id === e.id));
		const at = previous ? result.findIndex((r) => r.id === previous.id) + 1 : 0;
		result.splice(at, 0, entry);
	});
	return result;
}
