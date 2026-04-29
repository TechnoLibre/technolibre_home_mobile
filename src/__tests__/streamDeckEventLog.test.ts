import { describe, it, expect, beforeEach, vi } from "vitest";
import { streamDeckEventLog } from "../services/streamDeckEventLog";

describe("streamDeckEventLog", () => {
    beforeEach(() => {
        streamDeckEventLog.clear();
    });

    describe("add", () => {
        it("pushes to the front so newest is index 0", () => {
            streamDeckEventLog.add("first");
            streamDeckEventLog.add("second");
            const all = streamDeckEventLog.getAll();
            expect(all[0].text).toBe("second");
            expect(all[1].text).toBe("first");
        });

        it("attaches a timestamp string", () => {
            streamDeckEventLog.add("hello");
            const [entry] = streamDeckEventLog.getAll();
            expect(entry.ts).toMatch(/\d/);
            expect(typeof entry.ts).toBe("string");
        });

        it("caps the buffer at 500 entries", () => {
            for (let i = 0; i < 600; i++) streamDeckEventLog.add(`e${i}`);
            const all = streamDeckEventLog.getAll();
            expect(all).toHaveLength(500);
            expect(all[0].text).toBe("e599");
            expect(all[499].text).toBe("e100");
        });
    });

    describe("getAll", () => {
        it("returns a snapshot — mutating the copy does not affect store", () => {
            streamDeckEventLog.add("a");
            const snap = streamDeckEventLog.getAll();
            snap.push({ ts: "x", text: "tampered" });
            expect(streamDeckEventLog.getAll()).toHaveLength(1);
        });
    });

    describe("clear", () => {
        it("empties the buffer and notifies subscribers", () => {
            streamDeckEventLog.add("x");
            const fn = vi.fn();
            streamDeckEventLog.subscribe(fn);
            streamDeckEventLog.clear();
            expect(streamDeckEventLog.getAll()).toEqual([]);
            expect(fn).toHaveBeenCalledTimes(1);
        });
    });

    describe("subscribe", () => {
        it("notifies on every add and on clear", () => {
            const fn = vi.fn();
            streamDeckEventLog.subscribe(fn);
            streamDeckEventLog.add("a");
            streamDeckEventLog.add("b");
            streamDeckEventLog.clear();
            expect(fn).toHaveBeenCalledTimes(3);
        });

        it("returns an unsubscribe handle", () => {
            const fn = vi.fn();
            const off = streamDeckEventLog.subscribe(fn);
            streamDeckEventLog.add("a");
            off();
            streamDeckEventLog.add("b");
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it("isolates listener exceptions — other listeners still fire", () => {
            const bad = vi.fn(() => { throw new Error("boom"); });
            const good = vi.fn();
            streamDeckEventLog.subscribe(bad);
            streamDeckEventLog.subscribe(good);
            expect(() => streamDeckEventLog.add("x")).not.toThrow();
            expect(good).toHaveBeenCalledTimes(1);
        });
    });
});
