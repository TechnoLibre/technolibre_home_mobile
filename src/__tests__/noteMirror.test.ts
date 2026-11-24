import { describe, it, expect } from "vitest";
import {
  applyValues, changedFields, htmlToParagraphs, isAppLine, localValues, mergeFields, mirrorFields, remoteDay, titledValues,
} from "../services/noteMirror";
import type { Note } from "../models/note";

const note = (over: Partial<Note> = {}): Note => ({
  id: "n", title: "T", done: false, archived: false, pinned: false, tags: [], entries: [], ...over,
});

let counter = 0;
const newId = () => `id-${++counter}`;

describe("htmlToParagraphs", () => {
  it("reads blocks and line breaks as paragraphs, tags dropped, entities decoded", () => {
    expect(htmlToParagraphs("<p>One &amp; <b>two</b></p><div>Three<br/>Four</div><ul><li>Five</li></ul><p> </p>"))
      .toEqual(["One & two", "Three", "Four", "Five"]);
    expect(htmlToParagraphs(false)).toEqual([]);
  });

  it("tells the lines the app writes from entries", () => {
    expect(isAppLine("📷 Photo")).toBe(true);
    expect(isAppLine("📅 Date : 2026-11-01")).toBe(true);
    expect(isAppLine("erplibre-mobile:abc")).toBe(true);
    expect(isAppLine("Call the client")).toBe(false);
  });
});

describe("mirrored values", () => {
  it("reads the note's fields, its text apart from the app's lines, the marker left out", () => {
    const n = note({ title: " T  x ", tags: ["b", "a"], entries: [{ id: "d", type: "date", params: { date: "2026-11-01T14:00:00.000Z" } } as any] });
    const v = localValues(n, "<p>Hello</p>\n<p>📷 Photo</p>\n<p><small>erplibre-mobile:x</small></p>");
    expect(v).toMatchObject({ title: "T x", text: "Hello", media: "📷 Photo", tags: ["a", "b"], done: false });
    expect(v.date).toMatch(/^2026-11-0[12]$/);
  });

  it("takes the title of a body whose first paragraph is bold, absent otherwise", () => {
    expect(titledValues("<p><b>Job  1</b></p><p>Done</p><p>📷 Photo</p>")).toEqual({ title: "Job 1", text: "Done", media: "📷 Photo" });
    expect(titledValues("<p>Done</p>")).toEqual({ title: null, text: "Done", media: "" });
  });

  it("reads a Date as is and a Datetime in the device's day", () => {
    expect(remoteDay("2026-11-01")).toBe("2026-11-01");
    expect(remoteDay(false)).toBeNull();
    expect(remoteDay("2026-11-01 12:00:00")).toMatch(/^2026-11-0[12]$/);
  });

  it("mirrors what each kind has", () => {
    expect(mirrorFields("task", 16)).not.toContain("done");
    expect(mirrorFields("task", 17)).toContain("done");
    expect(mirrorFields("invoice", 18)).toEqual(["title", "text", "media"]);
    expect(mirrorFields("activity", 18)).toEqual(["title", "text", "media", "date"]);
  });
});

describe("mergeFields", () => {
  const base = { local: { title: "A", text: "x", tags: ["t"] }, remote: { title: "A", text: "x", tags: ["t"] } };

  it("never counts a pull-only field as the app's change, nor a push-only one as the server's", () => {
    const b = { local: { date: "2026-11-01", media: "📷 Photo" }, remote: { date: "2026-11-02", media: "📷 Photo" } };
    const m = mergeFields(["date", "media"], b, { date: "2026-11-05", media: "" }, { date: "2026-11-09", media: "x" }, ["date"], ["media"]);
    expect(m.apply).toEqual({ date: "2026-11-09" });
    expect(m.push).toEqual(["media"]);
    expect(m.conflicts).toEqual({});
  });

  it("takes the server's change, keeps the app's to send, and finds the conflicts", () => {
    const m = mergeFields(["title", "text", "tags"], base, { title: "A", text: "mine", tags: ["t", "u"] },
      { title: "B", text: "theirs", tags: ["t", "u"] });
    expect(m.apply).toEqual({ title: "B" });
    expect(m.conflicts).toEqual({ text: { mine: "mine", theirs: "theirs" } });
    expect(m.agreed).toEqual(["tags"]);
    expect(m.push).toEqual([]);
    expect(changedFields(["title", "text", "tags"], base, { title: "A", text: "y", tags: ["t"] })).toEqual(["text"]);
  });
});

describe("applyValues", () => {
  it("replaces the text entries where they were, keeping media and the date, skipping app lines", () => {
    const n = note({ entries: [
      { id: "p", type: "photo", params: { path: "p.jpg" } },
      { id: "t1", type: "text", params: { text: "old", readonly: false } },
      { id: "a", type: "audio", params: { path: "a.m4a" } },
      { id: "t2", type: "text", params: { text: "old 2", readonly: false } },
    ] as any });
    const next = applyValues(n, { text: "📷 Photo\nnew one\nnew two\n🎙️ Enregistrement audio" }, newId);
    expect(next.entries.map((e) => (e.type === "text" ? (e.params as any).text : e.type)))
      .toEqual(["photo", "new one", "new two", "audio"]);
  });

  it("keeps an unchanged text entry, with its translation", () => {
    const kept = { id: "t1", type: "text", params: { text: "Same", readonly: true, translation: "Pareil" } } as any;
    const next = applyValues(note({ entries: [kept] }), { text: "Same\nNew" }, newId);
    expect(next.entries[0]).toBe(kept);
    expect((next.entries[1].params as any).text).toBe("New");
  });

  it("sets, moves and removes the date entry, and copies the other fields", () => {
    const withDate = applyValues(note(), { date: "2026-11-05", tags: ["x"], done: true, title: "N" }, newId);
    expect(withDate.entries[0].type).toBe("date");
    expect(withDate).toMatchObject({ tags: ["x"], done: true, title: "N" });
    const moved = applyValues(withDate, { date: "2026-12-01" }, newId);
    expect(moved.entries).toHaveLength(1);
    expect(applyValues(moved, { date: null }, newId).entries).toHaveLength(0);
  });
});
