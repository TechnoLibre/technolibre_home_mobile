import { describe, it, expect } from "vitest";
import { mergeLocalEdit } from "../services/note/noteEditMerge";
import type { Note, NoteEntry } from "../models/note";

const text = (id: string, value: string): NoteEntry => ({ id, type: "text", params: { text: value, readonly: false } } as any);

const note = (over: Partial<Note> = {}): Note => ({
	id: "n", title: "Plan", done: false, archived: false, pinned: false, tags: ["a"],
	entries: [text("e1", "First"), text("e2", "Second")], ...over,
});

describe("mergeLocalEdit", () => {
	it("takes a field the stored note changed and the editor did not", () => {
		const since = note();
		const mine = note({ entries: [text("e1", "First typed"), text("e2", "Second")] });
		const stored = note({ title: "Server title", tags: ["a", "b"] });
		const merged = mergeLocalEdit(since, mine, stored);
		expect(merged.title).toBe("Server title");
		expect(merged.tags).toEqual(["a", "b"]);
		expect(merged.entries.map((e) => (e.params as any).text)).toEqual(["First typed", "Second"]);
	});

	it("keeps a field the editor changed, even when the stored note changed it too", () => {
		const merged = mergeLocalEdit(note(), note({ title: "Mine" }), note({ title: "Theirs" }));
		expect(merged.title).toBe("Mine");
	});

	it("takes the stored version of an entry the editor left as it was, and keeps the editor's own object", () => {
		const mine = note({ entries: [text("e1", "First typed"), text("e2", "Second")] });
		const stored = note({ entries: [text("e1", "First"), text("e2", "Second from server")] });
		const merged = mergeLocalEdit(note(), mine, stored);
		expect(merged.entries.map((e) => (e.params as any).text)).toEqual(["First typed", "Second from server"]);
		expect(merged.entries[0]).toBe(mine.entries[0]);
	});

	it("drops an entry the stored note dropped unless the editor changed it, and adds the stored note's new ones in place", () => {
		const since = note({ entries: [text("e1", "First"), text("e2", "Second"), text("e3", "Third")] });
		const mine = note({ entries: [text("e1", "First"), text("e2", "Second typed"), text("e3", "Third")] });
		// The server dropped e2 and e3 and added n1; the editor typed in e2
		const stored = note({ entries: [text("e1", "First"), text("n1", "New from server")] });
		const merged = mergeLocalEdit(since, mine, stored);
		expect(merged.entries.map((e) => e.id)).toEqual(["e1", "n1", "e2"]);
		expect((merged.entries[2].params as any).text).toBe("Second typed");
	});

	it("keeps an entry the editor added", () => {
		const mine = note({ entries: [text("e1", "First"), text("e2", "Second"), text("x", "Mine new")] });
		const merged = mergeLocalEdit(note(), mine, note({ title: "Server" }));
		expect(merged.entries.map((e) => e.id)).toEqual(["e1", "e2", "x"]);
		expect(merged.title).toBe("Server");
	});
});
