/**
 * The chat's emoji: the data converted from Odoo 18's emoji picker
 * (scripts/convert-odoo-emoji.mjs), loaded on first use in a chunk of its
 * own, the shortcode and emoticon conversions of the browser composer, the
 * search of the picker, and the « most used » counts behind the quick
 * reaction bar.
 */

/** A picker category, as Odoo's emoji data lists it. */
export interface EmojiCategory {
    name: string;
    title: string;
    sortId: number;
    displayName: { en: string; fr: string };
}

/** One emoji, its texts in English and in French (English where fr.po has none). */
export interface EmojiEntry {
    codepoints: string;
    /** The `name` of its EmojiCategory. */
    category: string;
    name: { en: string; fr: string };
    keywords: { en: string[]; fr: string[] };
    shortcodes: string[];
    emoticons: string[];
}

/** Categories and emojis in the order of Odoo's source. */
export interface EmojiData {
    categories: EmojiCategory[];
    emojis: EmojiEntry[];
}

/** A text the browser composer turns into an emoji. */
export type EmojiConversion = { source: string; codepoints: string };

/** The reaction bar before anything is used: 👍 ❤️ 😂 😮 😢 🙏 (❤️ is U+2764 U+FE0F). */
export const QUICK_REACTIONS: readonly string[] = [
    "\u{1F44D}", "❤️", "\u{1F602}", "\u{1F62E}", "\u{1F622}", "\u{1F64F}",
];

/** localStorage key of the use counts, `{codepoints: count}`, all accounts together. */
export const FREQUENT_KEY = "chat.emoji.frequent";

/** Uses an emoji outside QUICK_REACTIONS needs before it takes a slot of the bar. */
export const QUICK_MIN_USES = 3;

let loading: Promise<EmojiData> | null = null;

/**
 * The emoji data. The first call imports the JSON asset, which the build
 * keeps in its own chunk; every later call gets the same promise. A failed
 * import is forgotten, so the next call tries again.
 */
export function loadEmojiData(): Promise<EmojiData> {
    if (!loading) {
        loading = import("../../data/emojiData.json").then(
            (mod) => mod.default,
            (error) => {
                loading = null;
                throw error;
            },
        );
    }
    return loading;
}

/**
 * The texts the browser composer converts, in its order: per emoji in data
 * order, its shortcodes then its emoticons (Odoo's `_generateEmojisOnHtml`).
 */
export async function emojiConversions(): Promise<EmojiConversion[]> {
    const { emojis } = await loadEmojiData();
    return emojis.flatMap((e) =>
        [...e.shortcodes, ...e.emoticons].map((source) => ({ source, codepoints: e.codepoints })));
}

/** Lowercase, accents removed, so « Rieur » and « rieur », « fusée » and « fusee » compare equal. */
function fold(text: string): string {
    return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * The emojis, in data order, whose name or a keyword in `lang` or in
 * English, or a shortcode, contains the term once both are folded. A blank
 * term finds none.
 */
export function searchEmoji(data: EmojiData, term: string, lang: "fr" | "en"): EmojiEntry[] {
    const needle = fold(term.trim());
    if (!needle) return [];
    return data.emojis.filter((e) =>
        [e.name[lang], e.name.en, ...e.keywords[lang], ...e.keywords.en, ...e.shortcodes]
            .some((text) => fold(text).includes(needle)));
}

/** The stored counts; unreadable storage or a malformed value counts as none, a bad count is skipped. */
function readCounts(): Record<string, number> {
    try {
        const raw = JSON.parse(localStorage.getItem(FREQUENT_KEY) ?? "null");
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
        const counts: Record<string, number> = {};
        for (const [codepoints, count] of Object.entries(raw)) {
            if (typeof count === "number" && Number.isFinite(count) && count > 0) counts[codepoints] = count;
        }
        return counts;
    } catch {
        return {};
    }
}

/** Adds one use of the emoji to the counts; storage that cannot be written keeps the counts as they were. */
export function countEmojiUse(codepoints: string): void {
    const counts = readCounts();
    counts[codepoints] = (counts[codepoints] ?? 0) + 1;
    try {
        localStorage.setItem(FREQUENT_KEY, JSON.stringify(counts));
    } catch {
        // Not counted: the bar and the most used stay as they were
    }
}

/** Codepoints of the counts, most used first (equal counts in storage order). */
function byUse(counts: Record<string, number>): string[] {
    return Object.entries(counts).sort(([, a], [, b]) => b - a).map(([codepoints]) => codepoints);
}

/** The most used emojis, most used first, at most `limit` (42, as Odoo's picker). */
export function frequentEmoji(limit = 42): string[] {
    return byUse(readCounts()).slice(0, limit);
}

/**
 * The six emojis of the reaction bar. It starts from QUICK_REACTIONS; each
 * emoji outside them used at least QUICK_MIN_USES times, most used first,
 * takes the slot of the first emoji, scanning from the end, used less than
 * it. The first candidate that displaces none ends the scan: the ones after
 * it are used less still. `counts` defaults to the stored counts.
 */
export function quickReactions(counts: Record<string, number> = readCounts()): string[] {
    const slots = [...QUICK_REACTIONS];
    const used = (codepoints: string) => counts[codepoints] ?? 0;
    const candidates = byUse(counts)
        .filter((c) => !QUICK_REACTIONS.includes(c) && used(c) >= QUICK_MIN_USES);
    for (const candidate of candidates) {
        let slot = slots.length - 1;
        while (slot >= 0 && used(slots[slot]) >= used(candidate)) slot--;
        if (slot < 0) break;
        slots[slot] = candidate;
    }
    return slots;
}
