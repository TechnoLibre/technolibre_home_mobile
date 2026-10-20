import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// vitest.config.ts aliases @capacitor/core to src/__mocks__, whose
// registerPlugin resolves each method against __setPluginMock.
import { __setPluginMock, __clearPluginMocks } from "@capacitor/core";
import { streamDeckEventLog } from "../services/streamDeckEventLog";
import { OptionsStreamDeckComponent } from "../components/options/streamdeck/options_streamdeck_component";

const SOURCE = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../components/options/streamdeck/options_streamdeck_component.ts",
);

/** The raw markup between the backticks of the component's xml`…`.
 *  The Owl mock returns "" for xml, so the source file is read. */
function template(): string {
    const src = readFileSync(SOURCE, "utf-8");
    const m = src.match(/static template = xml`([\s\S]*?)`;/);
    if (!m) throw new Error("template literal not found");
    return m[1];
}

/** Any letter, in any script: a fragment holding one carries words. */
const LETTER = /\p{L}/u;

/** localStorage does not exist in the node environment; i18n reads it. */
function stubLocale(locale: "fr" | "en"): void {
    const store = new Map([["app_lang", locale]]);
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
    });
}

function panel(): any {
    return new (OptionsStreamDeckComponent as any)();
}

function deck(deckId: string): any {
    return { info: { deckId } };
}

describe("Options › Stream Deck — every visible string goes through t()", () => {
    const markup = template().replace(/<!--[\s\S]*?-->/g, "");

    it("finds the template it inspects", () => {
        expect(markup).toContain("options-streamdeck__toolbar");
    });

    it("has no words in its text nodes", () => {
        // A tag is matched with its double-quoted attribute values whole,
        // since handlers such as `() => this.refresh()` hold a `>`.
        const words = markup
            .split(/<[^>"]*(?:"[^"]*"[^>"]*)*>/)
            .map((s) => s.trim())
            .filter((s) => LETTER.test(s));
        expect(words).toEqual([]);
    });

    it("has no words in a static placeholder, title, alt or aria-label", () => {
        const words = [...markup.matchAll(/\s(?:placeholder|title|alt|aria-label)="([^"]*)"/g)]
            .map((m) => m[1])
            .filter((s) => LETTER.test(s));
        expect(words).toEqual([]);
    });

    it("has no words in a string literal of a t-esc or t-att-placeholder", () => {
        const words: string[] = [];
        for (const m of markup.matchAll(/\st-(?:esc|att-placeholder)="([^"]*)"/g)) {
            // The key passed to t() is the one literal allowed to hold words.
            const expr = m[1].replace(/\bt\(\s*'[^']*'/g, "t(");
            for (const lit of expr.matchAll(/'([^']*)'/g)) {
                // 'w' and 'h' name the bezel axis passed to borderSliderLabel.
                if (lit[1] === "w" || lit[1] === "h") continue;
                if (LETTER.test(lit[1])) words.push(lit[1]);
            }
        }
        expect(words).toEqual([]);
    });
});

describe("Options › Stream Deck — labels in each language", () => {
    beforeEach(() => {
        __clearPluginMocks();
        streamDeckEventLog.clear();
    });
    afterEach(() => vi.unstubAllGlobals());

    it("counts the connected decks in French, singular and plural", () => {
        stubLocale("fr");
        const c = panel();
        c.state.decks = [deck("A")];
        expect(c.headerLabel()).toBe("🎛️ Stream Deck — 1 connecté");
        c.state.decks = [deck("A"), deck("B")];
        expect(c.headerLabel()).toBe("🎛️ Stream Deck — 2 connectés");
        c.state.decks = [];
        expect(c.headerLabel()).toBe("🎛️ Stream Deck — 0 connectés");
    });

    it("counts the connected decks in English", () => {
        stubLocale("en");
        const c = panel();
        c.state.decks = [deck("A")];
        expect(c.headerLabel()).toBe("🎛️ Stream Deck — 1 connected");
        c.state.decks = [deck("A"), deck("B")];
        expect(c.headerLabel()).toBe("🎛️ Stream Deck — 2 connected");
    });

    it("names the default brightness in each language, and a set one as a percent", () => {
        stubLocale("fr");
        const c = panel();
        expect(c.brightnessLabel("A")).toBe("50% (par défaut)");
        stubLocale("en");
        expect(c.brightnessLabel("A")).toBe("50% (default)");
        c.state.brightness.A = 75;
        expect(c.brightnessLabel("A")).toBe("75%");
    });

    it("gives the LCD font size and scroll speed with their unit", () => {
        stubLocale("fr");
        const c = panel();
        expect(c.lcdFontSizeLabel("A")).toBe("48 px");
        expect(c.lcdScrollSpeedLabel("A")).toBe("2 px/trame");
        stubLocale("en");
        c.state.lcdScrollSpeed.A = 5;
        expect(c.lcdScrollSpeedLabel("A")).toBe("5 px/frame");
    });

    it("says a deck whose control pipe is down is retried, in each language", () => {
        stubLocale("fr");
        const c = panel();
        expect(c.controlPipeNotice({ controlPipeOk: false })).toBe(
            "Ce deck ne répond à aucune requête de contrôle : luminosité et "
            + "effacement des touches sont coupés jusqu'à ce qu'il réponde de "
            + "nouveau, essayé toutes les 5 secondes. Le débrancher puis le "
            + "rebrancher les rétablit.");
        stubLocale("en");
        expect(c.controlPipeNotice({ controlPipeOk: false })).toBe(
            "This deck answers no control request: brightness and key "
            + "clearing are off until it answers again, tried every 5 "
            + "seconds. Unplugging it and plugging it back in restores them.");
        expect(c.controlPipeNotice({ controlPipeOk: true })).toBe("");
        // Info without the field says nothing about the pipe.
        expect(c.controlPipeNotice({})).toBe("");
    });

    it("shows the control pipe notice under the deck's firmware line", () => {
        expect(template()).toMatch(
            /t-if="controlPipeNotice\(row\.info\)"[\s\S]*?t-esc="controlPipeNotice\(row\.info\)"/);
    });

    it("journals an empty USB scan in the reader's language", async () => {
        stubLocale("en");
        __setPluginMock("StreamDeckPlugin", {
            listAllUsbDevices: vi.fn(async () => ({ devices: [] })),
        });
        await panel().scanAllUsb();
        const texts = streamDeckEventLog.getAll().map((e) => e.text);
        expect(texts).toContain("⚠️ no USB device — OTG inactive or cable faulty");
    });
});
