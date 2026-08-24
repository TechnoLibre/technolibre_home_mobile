import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vitest.config.ts already aliases @odoo/owl and @capacitor/dialog to the
// mocks in src/__mocks__ — a vi.mock() here would automock those away.
import { Dialog } from "@capacitor/dialog";
import { OptionsChangelogComponent } from "../components/options/changelog/options_changelog_component";

const CHANGELOG = `# Changelog

## [Unreleased]

## [2026.08.24.01] - 2026-08-24

### Added
- **Thing** in \`code\`
`;

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

/** The Owl mock makes onWillStart a no-op, so setup() then load() by hand. */
function make(locale: "fr" | "en" = "en") {
    stubLocale(locale);
    const c = new (OptionsChangelogComponent as any)();
    c.setup();
    return c;
}

const okOnce = (body: string) =>
    vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(body) });

beforeEach(() => {
    (Dialog.alert as any).mockClear();
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe("OptionsChangelogComponent", () => {
    it("shows the version read from the bundled changelog", async () => {
        vi.stubGlobal("fetch", okOnce(CHANGELOG));
        const c = make();
        await c.load();
        expect(c.state.version).toBe("2026.08.24.01");
        expect(c.label).toContain("2026.08.24.01");
        expect(c.state.body).toContain("=== 2026.08.24.01 ===");
    });

    it("reads the French changelog when the locale is French", async () => {
        const f = okOnce(CHANGELOG);
        vi.stubGlobal("fetch", f);
        await make("fr").load();
        expect(f).toHaveBeenCalledWith("/repo/CHANGELOG.fr.md");
    });

    it("reads the English changelog otherwise", async () => {
        const f = okOnce(CHANGELOG);
        vi.stubGlobal("fetch", f);
        await make("en").load();
        expect(f).toHaveBeenCalledWith("/repo/CHANGELOG.md");
    });

    it("falls back to the plain label when the bundle is missing", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
        const c = make();
        await c.load();
        expect(c.state.version).toBe("");
        expect(c.label).toBe("Changelog");
    });

    it("survives a fetch that throws", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
        const c = make();
        await expect(c.load()).resolves.toBeUndefined();
        expect(c.state.version).toBe("");
    });

    it("explains itself in the dialog when nothing loaded", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
        const c = make();
        await c.load();
        await c.onChangelogClick();
        const arg = (Dialog.alert as any).mock.calls[0][0];
        expect(arg.message).toContain("npm run build");
    });

    it("puts the version in the dialog title once loaded", async () => {
        vi.stubGlobal("fetch", okOnce(CHANGELOG));
        const c = make();
        await c.load();
        await c.onChangelogClick();
        const arg = (Dialog.alert as any).mock.calls[0][0];
        expect(arg.title).toContain("2026.08.24.01");
        expect(arg.message).toContain("Added:");
    });
});
