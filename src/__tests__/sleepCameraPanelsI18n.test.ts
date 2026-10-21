import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { t } from "../i18n";
import { translations as en } from "../i18n/en";
import { translations as fr } from "../i18n/fr";
import { OptionsCameraStreamComponent } from "../components/options/camera_stream/options_camera_stream_component";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Each panel's source file, with a class name its template carries. */
const PANELS = [
    {
        name: "Sleep",
        file: "../components/options/keep_awake/options_keep_awake_component.ts",
        marker: 'id="keep-awake"',
    },
    {
        name: "Camera → Stream Deck",
        file: "../components/options/camera_stream/options_camera_stream_component.ts",
        marker: 'id="camera-stream"',
    },
];

function source(file: string): string {
    return readFileSync(resolve(HERE, file), "utf-8");
}

/** The raw markup between the backticks of the component's xml`…`.
 *  The Owl mock returns "" for xml, so the source file is read. */
function template(file: string): string {
    const m = source(file).match(/static template = xml`([\s\S]*?)`;/);
    if (!m) throw new Error("template literal not found");
    return m[1].replace(/<!--[\s\S]*?-->/g, "");
}

/** Every key a component passes to t() as a literal, template included. */
function keysUsed(file: string): string[] {
    const keys = [...source(file).matchAll(/\bt\(\s*['"]([a-z0-9_.]+)['"]/g)]
        .map((m) => m[1]);
    return [...new Set(keys)];
}

/** Any letter, in any script: a fragment holding one carries words. */
const LETTER = /\p{L}/u;

/** A Latin letter with a diacritic, which French text carries and code
 *  identifiers here never do. */
const ACCENTED = /[À-ÖØ-öø-ÿŒœ]/;

/** localStorage does not exist in the node environment; i18n reads it. */
function stubLocale(locale: "fr" | "en"): void {
    const store = new Map([["app_lang", locale]]);
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
    });
}

describe.each(PANELS)("Options › $name — every visible string goes through t()", ({ file, marker }) => {
    const markup = template(file);

    it("finds the template it inspects", () => {
        expect(markup).toContain(marker);
    });

    it("has no words in its text nodes", () => {
        // A tag is matched with its double-quoted attribute values whole,
        // since handlers such as `() => this.onToggle()` hold a `>`.
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

    it("has no words in a string literal of a t-esc", () => {
        const words: string[] = [];
        for (const m of markup.matchAll(/\st-esc="([^"]*)"/g)) {
            // The key passed to t() is the one literal allowed to hold words.
            const expr = m[1].replace(/\bt\(\s*'[^']*'/g, "t(");
            for (const lit of expr.matchAll(/'([^']*)'/g)) {
                if (LETTER.test(lit[1])) words.push(lit[1]);
            }
        }
        expect(words).toEqual([]);
    });

    it("leaves no French text anywhere in its code", () => {
        // Comments may quote a label; code and strings may not.
        const code = source(file)
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\n]*/g, "")
            .replace(/<!--[\s\S]*?-->/g, "");
        const lines = code.split("\n").filter((l) => ACCENTED.test(l));
        expect(lines).toEqual([]);
    });

    it("uses only keys that both dictionaries define", () => {
        const keys = keysUsed(file);
        expect(keys.length).toBeGreaterThan(1);
        expect(keys.filter((k) => !(k in en))).toEqual([]);
        expect(keys.filter((k) => !(k in fr))).toEqual([]);
    });

    it("puts its section emoji in the label only once", () => {
        // The emoji lives in the dictionary value, not before the t-esc.
        expect(markup).toMatch(/<span t-esc="t\('section\.[a-z_]+'\)"\/>/);
    });
});

describe("Options › Sleep and Camera — dictionaries", () => {
    it("defines the same sleep.* and camera_stream.* keys in en and fr", () => {
        const ours = (d: Record<string, string>) => Object.keys(d)
            .filter((k) => k.startsWith("sleep.") || k.startsWith("camera_stream."))
            .sort();
        expect(ours(en)).toEqual(ours(fr));
        expect(ours(en).length).toBeGreaterThan(15);
    });
});

describe("Options › Sleep and Camera — labels in each language", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("names the section headers with a single emoji", () => {
        stubLocale("fr");
        expect(t("section.sleep")).toBe("🌙 Mise en veille");
        expect(t("section.camera_to_deck")).toBe("📷 Caméra → Stream Deck");
        stubLocale("en");
        expect(t("section.sleep")).toBe("🌙 Sleep");
        expect(t("section.camera_to_deck")).toBe("📷 Camera → Stream Deck");
    });

    it("keeps the screen-on option's French wording, and says it in English", () => {
        stubLocale("fr");
        expect(t("sleep.screen_on")).toBe("Empêcher la mise en veille");
        expect(t("sleep.screen_on_hint")).toBe(
            "L'écran du téléphone reste allumé tant que cette option est "
            + "cochée. Utile quand un Stream Deck est branché et qu'on ne veut "
            + "pas que la LCD se ternisse avec le timeout d'écran. Pensez à "
            + "désactiver pour économiser la batterie.");
        stubLocale("en");
        expect(t("sleep.screen_on")).toBe("Prevent sleep");
    });

    it("counts the decks on the start button, singular and plural", () => {
        const c = new (OptionsCameraStreamComponent as any)();
        stubLocale("fr");
        c.state.deckCount = 0;
        expect(c.toggleLabel()).toBe("▶ Activer (0 decks)");
        c.state.deckCount = 1;
        expect(c.toggleLabel()).toBe("▶ Activer (1 deck)");
        c.state.deckCount = 2;
        expect(c.toggleLabel()).toBe("▶ Activer (2 decks)");
        stubLocale("en");
        c.state.deckCount = 1;
        expect(c.toggleLabel()).toBe("▶ Enable (1 deck)");
        c.state.deckCount = 3;
        expect(c.toggleLabel()).toBe("▶ Enable (3 decks)");
    });

    it("turns the start button into a stop button while streaming", () => {
        const c = new (OptionsCameraStreamComponent as any)();
        c.state.active = true;
        stubLocale("fr");
        expect(c.toggleLabel()).toBe("⏹ Désactiver");
        stubLocale("en");
        expect(c.toggleLabel()).toBe("⏹ Disable");
    });

    it("gives the frame rate unit in each language", () => {
        stubLocale("fr");
        expect(t("camera_stream.fps_unit")).toBe("i/s");
        expect(t("camera_stream.fps_hint")).toContain("Défaut 5 i/s.");
        stubLocale("en");
        expect(t("camera_stream.fps_unit")).toBe("fps");
        expect(t("camera_stream.fps_hint")).toContain("Default 5 fps.");
    });

    it("labels the face detection counters in each language", () => {
        stubLocale("fr");
        expect([
            t("camera_stream.face_calls"),
            t("camera_stream.face_hits"),
            t("camera_stream.face_current"),
        ]).toEqual(["Diagnostic — appels:", "hits:", "visages courants:"]);
        stubLocale("en");
        expect(t("camera_stream.face_current")).toBe("current faces:");
    });
});
