import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    CodeStyleService,
    CODE_STYLE_ENTRIES,
} from "../services/codeStyleService";

// Minimal `document.documentElement.style` stub. Vitest runs in node
// env, so document is not provided by default.
function stubDocument() {
    const props = new Map<string, string>();
    const style = {
        setProperty: vi.fn((k: string, v: string) => { props.set(k, v); }),
        removeProperty: vi.fn((k: string) => { props.delete(k); }),
        get(k: string): string | undefined { return props.get(k); },
    };
    vi.stubGlobal("document", { documentElement: { style } });
    return { style, props };
}

function fakeDb(initial: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(initial));
    return {
        getUserGraphicPref: vi.fn(async (k: string) => store.get(k) ?? null),
        setUserGraphicPref: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
        _store: store,
    } as any;
}

describe("CodeStyleService", () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    describe("loadAndApply", () => {
        it("applies every stored override to documentElement", async () => {
            const { style, props } = stubDocument();
            const db = fakeDb({
                code_edit_btn_bg: "#ff0000",
                code_commit_btn_bg: "#00ff00",
            });
            const svc = new CodeStyleService(db);
            await svc.loadAndApply();
            expect(props.get("--code-edit-btn-bg")).toBe("#ff0000");
            expect(props.get("--code-commit-btn-bg")).toBe("#00ff00");
            // Untouched entry stays unset.
            expect(props.get("--code-warning-bg")).toBeUndefined();
            expect(style.setProperty).toHaveBeenCalledTimes(2);
        });

        it("ignores invalid hex values without throwing", async () => {
            const { props } = stubDocument();
            const db = fakeDb({ code_edit_btn_bg: "not-a-color" });
            const svc = new CodeStyleService(db);
            await svc.loadAndApply();
            expect(props.get("--code-edit-btn-bg")).toBeUndefined();
        });
    });

    describe("setColor", () => {
        it("persists and applies a valid hex", async () => {
            const { props } = stubDocument();
            const db = fakeDb();
            const svc = new CodeStyleService(db);
            await svc.setColor("code_edit_btn_bg", "#abcdef");
            expect(db.setUserGraphicPref).toHaveBeenCalledWith(
                "code_edit_btn_bg", "#abcdef",
            );
            expect(props.get("--code-edit-btn-bg")).toBe("#abcdef");
        });

        it("rejects an unknown prefKey", async () => {
            stubDocument();
            const svc = new CodeStyleService(fakeDb());
            await expect(svc.setColor("nope", "#000000")).rejects.toThrow(
                /Unknown code style pref/,
            );
        });

        it("rejects a non-hex value", async () => {
            stubDocument();
            const svc = new CodeStyleService(fakeDb());
            await expect(
                svc.setColor("code_edit_btn_bg", "rgb(0,0,0)"),
            ).rejects.toThrow(/Invalid color/);
        });
    });

    describe("resetColor", () => {
        it("clears the override and removes the property", async () => {
            const { style, props } = stubDocument();
            const db = fakeDb({ code_edit_btn_bg: "#ff0000" });
            const svc = new CodeStyleService(db);
            await svc.loadAndApply();
            await svc.resetColor("code_edit_btn_bg");
            expect(db.setUserGraphicPref).toHaveBeenCalledWith(
                "code_edit_btn_bg", "",
            );
            expect(props.get("--code-edit-btn-bg")).toBeUndefined();
            expect(style.removeProperty).toHaveBeenCalledWith(
                "--code-edit-btn-bg",
            );
        });

        it("rejects an unknown prefKey", async () => {
            stubDocument();
            const svc = new CodeStyleService(fakeDb());
            await expect(svc.resetColor("nope")).rejects.toThrow(
                /Unknown code style pref/,
            );
        });
    });

    describe("resetAll", () => {
        it("clears every override and removes every property", async () => {
            const { style, props } = stubDocument();
            const db = fakeDb({
                code_edit_btn_bg: "#ff0000",
                code_commit_btn_bg: "#00ff00",
            });
            const svc = new CodeStyleService(db);
            await svc.loadAndApply();
            await svc.resetAll();
            for (const e of CODE_STYLE_ENTRIES) {
                expect(props.get(e.cssVar)).toBeUndefined();
            }
            expect(style.removeProperty).toHaveBeenCalledTimes(
                CODE_STYLE_ENTRIES.length,
            );
        });
    });

    describe("getCurrent", () => {
        it("returns the override when set and valid", async () => {
            stubDocument();
            const db = fakeDb({ code_edit_btn_bg: "#abcdef" });
            const svc = new CodeStyleService(db);
            expect(await svc.getCurrent("code_edit_btn_bg")).toBe("#abcdef");
        });

        it("returns the default when override is missing", async () => {
            stubDocument();
            const svc = new CodeStyleService(fakeDb());
            const entry = CODE_STYLE_ENTRIES.find(
                (e) => e.prefKey === "code_edit_btn_bg",
            )!;
            expect(await svc.getCurrent("code_edit_btn_bg")).toBe(
                entry.defaultValue,
            );
        });

        it("returns the default when override is invalid", async () => {
            stubDocument();
            const db = fakeDb({ code_edit_btn_bg: "garbage" });
            const svc = new CodeStyleService(db);
            const entry = CODE_STYLE_ENTRIES.find(
                (e) => e.prefKey === "code_edit_btn_bg",
            )!;
            expect(await svc.getCurrent("code_edit_btn_bg")).toBe(
                entry.defaultValue,
            );
        });

        it("falls back to black for an unknown prefKey", async () => {
            stubDocument();
            const svc = new CodeStyleService(fakeDb());
            expect(await svc.getCurrent("nope")).toBe("#000000");
        });
    });
});
