import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    streamDeckEventLog,
    reattachGaveUpText,
    permissionDeniedText,
} from "../services/streamDeckEventLog";
import { translations as en } from "../i18n/en";
import { translations as fr } from "../i18n/fr";

/** localStorage does not exist in the node environment; i18n reads it. */
function stubLocale(locale: "fr" | "en") {
    const store: Record<string, string> = { app_lang: locale };
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
        clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    });
}

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

    describe("reattachGaveUpText", () => {
        afterEach(() => vi.unstubAllGlobals());

        const ev = {
            deckId: "CL00A0000000",
            deviceName: "/dev/bus/usb/001/002",
            attempts: 3,
            reason: "polled_reset",
        };

        it("names the deck, the attempts and the last reason, in English", () => {
            stubLocale("en");
            const text = reattachGaveUpText(ev);
            expect(text).toContain("CL00A0000000");
            expect(text).toContain("3");
            expect(text).toContain("polled_reset");
            expect(text).not.toContain("streamdeck.");
            expect(text).not.toContain("{");
        });

        it("is translated in French", () => {
            stubLocale("en");
            const en = reattachGaveUpText(ev);
            stubLocale("fr");
            const fr = reattachGaveUpText(ev);
            expect(fr).toContain("CL00A0000000");
            expect(fr).not.toBe(en);
        });

        it("falls back to the USB device name when the serial is unknown", () => {
            stubLocale("en");
            expect(reattachGaveUpText({ ...ev, deckId: "" })).toContain("/dev/bus/usb/001/002");
        });

        it.each([["en", en], ["fr", fr]] as const)(
            "%s: a missing permission names the permission button, not a replug",
            (locale, dict) => {
                stubLocale(locale);
                const text = reattachGaveUpText({ ...ev, reason: "permission_missing" });
                expect(text).toContain("CL00A0000000");
                expect(text).toContain(dict["streamdeck.request_permission"]);
                expect(text).not.toBe(reattachGaveUpText(ev));
                expect(text).not.toContain("{");
            },
        );

        it.each(["en", "fr"] as const)(
            "%s: a missing permission gives no attempt count, given up at the first",
            (locale) => {
                stubLocale(locale);
                const text = reattachGaveUpText({
                    ...ev,
                    attempts: 1,
                    reason: "permission_missing",
                });
                expect(text).toContain("CL00A0000000");
                expect(text).not.toMatch(/\b1\b/);
            },
        );
    });

    describe("permissionDeniedText", () => {
        afterEach(() => vi.unstubAllGlobals());

        it.each([
            ["en", en, "permission_missing"],
            ["fr", fr, "permission_missing"],
            ["en", en, "permission_timeout"],
            ["fr", fr, "permission_timeout"],
            ["en", en, "permission_denied"],
            ["fr", fr, "permission_denied"],
        ] as const)("%s: %s says how to grant the permission", (locale, dict, reason) => {
            stubLocale(locale);
            const text = permissionDeniedText({ deckId: "", reason });
            expect(text).toContain(dict["streamdeck.request_permission"]);
            expect(text).not.toContain("streamdeck.");
            expect(text).not.toContain("{");
        });

        it("tells a missing grant from an unanswered and a refused dialog", () => {
            stubLocale("en");
            const texts = new Set(
                ["permission_missing", "permission_timeout", "permission_denied"].map(
                    (reason) => permissionDeniedText({ deckId: "", reason }),
                ),
            );
            expect(texts.size).toBe(3);
        });

        it("keeps any other reason as it came", () => {
            stubLocale("en");
            expect(permissionDeniedText({ deckId: "", reason: "open_failed:x" }))
                .toBe("permissionDenied: open_failed:x");
            expect(permissionDeniedText({ deckId: "" })).toBe("permissionDenied: no reason");
        });
    });
});
