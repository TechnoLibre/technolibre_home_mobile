#!/usr/bin/env node
/**
 * Converts Odoo 18's emoji data into the app's emoji asset, once, by hand:
 *
 *   node scripts/convert-odoo-emoji.mjs <emoji_data.js> <web/i18n/fr.po>
 *
 * emoji_data.js is `web/static/src/core/emoji_picker/emoji_data.js`: JSON
 * held in JavaScript template literals, each translatable text spliced in
 * as "` + _t("…") + `". The template literals of _getCategories and
 * _getEmojisData1…8 are evaluated twice, once with _t giving the English
 * text and once with _t giving fr.po's msgstr (English when the entry is
 * missing or empty), then parsed as JSON as Odoo does; the two parses
 * share their shape, so each text pairs with its translation by position.
 *
 * Writes src/data/emojiData.json (categories and emojis in source order)
 * and src/assets/licenses/unicode-cldr.LICENSE.txt (the Unicode licence of
 * the source header, comment marks removed). Exits non-zero when the
 * emoji count differs from the number of "codepoints" keys in the source.
 * The app build never runs it and never reads the Odoo checkout.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JSON_OUT = resolve(ROOT, "src/data/emojiData.json");
const LICENSE_OUT = resolve(ROOT, "src/assets/licenses/unicode-cldr.LICENSE.txt");

/** The value of a PO quoted string, its escapes (\" \\ \n \t \r) decoded. */
function poString(quoted) {
    const body = quoted.trim().replace(/^"/, "").replace(/"$/, "");
    return body.replace(/\\(["\\ntr])/g, (_, c) => ({ n: "\n", t: "\t", r: "\r" })[c] ?? c);
}

/**
 * msgid → msgstr of a PO file. Entries with an empty msgstr, obsolete
 * entries (`#~`) and the header (empty msgid) are left out.
 */
export function parsePo(text) {
    const map = new Map();
    let field = null;
    let entry = { msgid: "", msgstr: "" };
    const flush = () => {
        if (entry.msgid && entry.msgstr) map.set(entry.msgid, entry.msgstr);
        entry = { msgid: "", msgstr: "" };
        field = null;
    };
    for (const line of text.split("\n")) {
        const keyword = /^(msgid|msgstr)\s+(".*")\s*$/.exec(line);
        if (keyword) {
            if (keyword[1] === "msgid") flush();
            field = keyword[1];
            entry[field] = poString(keyword[2]);
        } else if (/^\s*"/.test(line) && field) {
            entry[field] += poString(line);
        } else if (!line.trim()) {
            flush();
        } else if (!line.startsWith("#")) {
            field = null;
        }
    }
    flush();
    return map;
}

/**
 * Categories and emojis of the source with _t giving `translate(text)`:
 * the module is run without its import and its exports, in a context that
 * holds nothing but the translation function.
 */
function evaluate(source, translate) {
    const code = source
        .replace(/^import .*$/m, "")
        .replace(/^export function/gm, "function")
        + "\n({ categories: getCategories(), emojis: getEmojis() });";
    return vm.runInNewContext(code, { realT: translate }, { timeout: 10000 });
}

/** The Unicode licence block of the source header, comment marks removed. */
function licenseOf(source) {
    const block = /\/\*\*\n([\s\S]*?)\n \*\//.exec(source);
    if (!block || !block[1].includes("UNICODE, INC. LICENSE AGREEMENT")) {
        throw new Error("the Unicode licence header was not found");
    }
    return block[1].split("\n").map((l) => l.replace(/^ \* ?| \*$/g, "")).join("\n").trim() + "\n";
}

function pair(en, fr) {
    return { en, fr };
}

export function convert(source, po) {
    const fr = parsePo(po);
    const english = evaluate(source, (text) => text);
    const french = evaluate(source, (text) => fr.get(text) || text);
    const expected = (source.match(/"codepoints"/g) ?? []).length;
    if (english.emojis.length !== expected) {
        throw new Error(`${english.emojis.length} emojis parsed, ${expected} "codepoints" in the source`);
    }
    const categories = english.categories.map((c, i) => ({
        name: c.name,
        title: c.title,
        sortId: c.sortId,
        displayName: pair(c.displayName, french.categories[i].displayName),
    }));
    const emojis = english.emojis.map((e, i) => ({
        codepoints: e.codepoints,
        category: e.category,
        name: pair(e.name, french.emojis[i].name),
        keywords: pair(e.keywords, french.emojis[i].keywords),
        shortcodes: e.shortcodes,
        emoticons: e.emoticons,
    }));
    return { data: { categories, emojis }, license: licenseOf(source) };
}

function main(argv) {
    if (argv.length !== 2) {
        console.error("usage: node scripts/convert-odoo-emoji.mjs <emoji_data.js> <web/i18n/fr.po>");
        process.exit(2);
    }
    const { data, license } = convert(readFileSync(argv[0], "utf8"), readFileSync(argv[1], "utf8"));
    writeFileSync(JSON_OUT, JSON.stringify(data) + "\n");
    writeFileSync(LICENSE_OUT, license);
    const translated = data.emojis.filter((e) => e.name.fr !== e.name.en).length;
    console.log(`${data.emojis.length} emojis, ${data.categories.length} categories, `
        + `${translated} names translated → ${JSON_OUT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2));
}
