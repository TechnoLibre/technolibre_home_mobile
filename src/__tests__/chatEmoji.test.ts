import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
    FREQUENT_KEY,
    QUICK_MIN_USES,
    QUICK_REACTIONS,
    countEmojiUse,
    emojiConversions,
    frequentEmoji,
    loadEmojiData,
    quickReactions,
    searchEmoji,
} from "../services/chat/chatEmoji";
// @ts-expect-error the conversion script is plain JavaScript without types
import { parsePo } from "../../scripts/convert-odoo-emoji.mjs";

function memoryStorage() {
    const items = new Map<string, string>();
    return {
        getItem: (k: string) => items.get(k) ?? null,
        setItem: (k: string, v: string) => { items.set(k, String(v)); },
        removeItem: (k: string) => { items.delete(k); },
    };
}

const brokenStorage = {
    getItem: () => { throw new Error("storage unavailable"); },
    setItem: () => { throw new Error("storage unavailable"); },
    removeItem: () => { throw new Error("storage unavailable"); },
};

afterEach(() => vi.unstubAllGlobals());

describe("emoji data", () => {
    it("holds the six quick reactions with their exact codepoints", async () => {
        expect(QUICK_REACTIONS).toEqual([
            "\u{1F44D}", "❤️", "\u{1F602}", "\u{1F62E}", "\u{1F622}", "\u{1F64F}",
        ]);
        const data = await loadEmojiData();
        const all = new Set(data.emojis.map((e) => e.codepoints));
        for (const emoji of QUICK_REACTIONS) expect(all.has(emoji)).toBe(true);
    });

    it("gives every emoji a known category, in the source's count", async () => {
        const data = await loadEmojiData();
        const names = new Set(data.categories.map((c) => c.name));
        expect(data.categories).toHaveLength(8);
        expect(data.emojis).toHaveLength(1455);
        for (const emoji of data.emojis) expect(names.has(emoji.category)).toBe(true);
    });

    it("names the emoji in French and in English", async () => {
        const data = await loadEmojiData();
        const grinning = data.emojis.find((e) => e.codepoints === "\u{1F600}")!;
        expect(grinning.name).toEqual({ en: "grinning face", fr: "visage rieur" });
        expect(grinning.keywords.en).toContain("grin");
        expect(grinning.keywords.fr).toHaveLength(grinning.keywords.en.length);
        expect(grinning.shortcodes).toEqual([":grinning:"]);
        const smileys = data.categories.find((c) => c.sortId === 1)!;
        expect(smileys.displayName).toEqual({ en: "Smileys & Emotion", fr: "Smileys & Émotions" });
    });

    it("loads once", async () => {
        expect(loadEmojiData()).toBe(loadEmojiData());
    });

    it("ships the Unicode licence of the source header", () => {
        const text = readFileSync("src/assets/licenses/unicode-cldr.LICENSE.txt", "utf8");
        expect(text.startsWith("UNICODE, INC. LICENSE AGREEMENT - DATA FILES AND SOFTWARE")).toBe(true);
        expect(text).toContain("Copyright © 1991-2022 Unicode, Inc.");
        expect(text).not.toMatch(/^\s*\*/m);
    });
});

describe("emojiConversions", () => {
    it("lists each emoji's shortcodes then its emoticons, in data order", async () => {
        const conversions = await emojiConversions();
        const index = (source: string) => conversions.findIndex((c) => c.source === source);
        expect(conversions[index(":smiley:")].codepoints).toBe("\u{1F603}");
        expect(conversions[index(":D")].codepoints).toBe("\u{1F603}");
        expect(index(":smiley:")).toBeLessThan(index(":D"));
        expect(index(":grinning:")).toBeLessThan(index(":smiley:"));
        expect(conversions[0]).toEqual({ source: ":grinning:", codepoints: "\u{1F600}" });
    });
});

describe("searchEmoji", () => {
    it("finds by the name in the language, in English, folded", async () => {
        const data = await loadEmojiData();
        const has = (term: string, lang: "fr" | "en") =>
            searchEmoji(data, term, lang).some((e) => e.codepoints === "\u{1F600}");
        expect(has("rieur", "fr")).toBe(true);
        expect(has("RIEUR", "fr")).toBe(true);
        expect(has("grinning", "fr")).toBe(true);
        expect(has("rieur", "en")).toBe(false);
    });

    it("finds by a shortcode, and nothing for a blank term", async () => {
        const data = await loadEmojiData();
        expect(searchEmoji(data, ":smiley:", "en").map((e) => e.codepoints)).toContain("\u{1F603}");
        expect(searchEmoji(data, "  ", "fr")).toEqual([]);
    });

    it("folds accents on both sides", async () => {
        const data = await loadEmojiData();
        const accented = data.emojis.find((e) => /[éèê]/.test(e.name.fr))!;
        const plain = accented.name.fr.normalize("NFD").replace(/\p{M}/gu, "");
        expect(searchEmoji(data, plain, "fr")).toContain(accented);
    });
});

describe("most used", () => {
    beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));

    it("counts every use, all accounts together, most used first", () => {
        countEmojiUse("\u{1F600}");
        countEmojiUse("\u{1F680}");
        countEmojiUse("\u{1F680}");
        expect(JSON.parse(localStorage.getItem(FREQUENT_KEY)!)).toEqual({ "\u{1F600}": 1, "\u{1F680}": 2 });
        expect(frequentEmoji()).toEqual(["\u{1F680}", "\u{1F600}"]);
        expect(frequentEmoji(1)).toEqual(["\u{1F680}"]);
    });

    it("caps the most used at 42 by default", () => {
        const counts: Record<string, number> = {};
        for (let i = 0; i < 50; i++) counts[String.fromCodePoint(0x1F300 + i)] = i + 1;
        localStorage.setItem(FREQUENT_KEY, JSON.stringify(counts));
        expect(frequentEmoji()).toHaveLength(42);
    });

    it("counts unreadable storage as empty", () => {
        localStorage.setItem(FREQUENT_KEY, "{bad");
        expect(frequentEmoji()).toEqual([]);
        expect(quickReactions()).toEqual(QUICK_REACTIONS);
        countEmojiUse("\u{1F600}");
        expect(frequentEmoji()).toEqual(["\u{1F600}"]);
        localStorage.setItem(FREQUENT_KEY, JSON.stringify({ "\u{1F600}": "many", "\u{1F680}": 4 }));
        expect(frequentEmoji()).toEqual(["\u{1F680}"]);
        vi.stubGlobal("localStorage", brokenStorage);
        expect(frequentEmoji()).toEqual([]);
        expect(quickReactions()).toEqual(QUICK_REACTIONS);
        expect(() => countEmojiUse("\u{1F600}")).not.toThrow();
    });
});

describe("quickReactions", () => {
    const [thumb, heart, joy, wow, sad, pray] = QUICK_REACTIONS;
    const rocket = "\u{1F680}";

    it("gives the six defaults when nothing is used", () => {
        expect(quickReactions({})).toEqual(QUICK_REACTIONS);
        expect(QUICK_MIN_USES).toBe(3);
    });

    it("puts an emoji used three times in the last slot", () => {
        expect(quickReactions({ [rocket]: 3 })).toEqual([thumb, heart, joy, wow, sad, rocket]);
    });

    it("keeps the defaults for an emoji used twice", () => {
        expect(quickReactions({ [rocket]: 2 })).toEqual(QUICK_REACTIONS);
    });

    it("keeps a heavily used default in its slot", () => {
        expect(quickReactions({ [pray]: 10, [rocket]: 5 })).toEqual([thumb, heart, joy, wow, rocket, pray]);
    });

    it("fills the six slots from seven candidates, most used at the end", () => {
        const candidates = Array.from({ length: 7 }, (_, i) => String.fromCodePoint(0x1F330 + i));
        const counts = Object.fromEntries(candidates.map((c, i) => [c, 10 - i]));
        expect(quickReactions(counts)).toEqual(candidates.slice(0, 6).reverse());
        expect(quickReactions(counts)).toHaveLength(6);
    });

    it("reads the stored counts when none are given", () => {
        vi.stubGlobal("localStorage", memoryStorage());
        localStorage.setItem(FREQUENT_KEY, JSON.stringify({ [rocket]: 4, [heart]: 1 }));
        expect(quickReactions()).toEqual([thumb, heart, joy, wow, sad, rocket]);
    });
});

describe("convert-odoo-emoji parsePo", () => {
    it("reads msgid to msgstr, multi-line and escaped, empty and obsolete entries left out", () => {
        const po = [
            'msgid ""', 'msgstr ""', '"Language: fr\\n"', "",
            "#: code:addons/web/static/src/core/emoji_picker/emoji_data.js:0",
            'msgid "rocket"', 'msgstr "fusée"', "",
            'msgid "quote \\"mark\\""', 'msgstr ""', '"guillemet \\"droit\\" "', '"et \\\\ barre"', "",
            'msgid "untranslated"', 'msgstr ""', "",
            '#~ msgid "gone"', '#~ msgstr "parti"', "",
        ].join("\n");
        const map: Map<string, string> = parsePo(po);
        expect(map.get("rocket")).toBe("fusée");
        expect(map.get('quote "mark"')).toBe('guillemet "droit" et \\ barre');
        expect(map.has("untranslated")).toBe(false);
        expect(map.has("gone")).toBe(false);
        expect(map.has("")).toBe(false);
    });
});
