import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { translations as fr } from "../i18n/fr";
import { translations as en } from "../i18n/en";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Directories that hold fixtures or generated output rather than app code. */
const SKIP = ["__tests__", "__mocks__", "i18n", "public"];

function sources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (SKIP.includes(name) || name === "__owl-precompiled__.ts") continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) sources(p, out);
        else if (name.endsWith(".ts")) out.push(p);
    }
    return out;
}

/**
 * `t("some.key")` / `t('some.key')` where the literal is the whole argument.
 * The trailing `[),]` is what excludes a key built at runtime, such as
 * `t('language.' + locale.key)` — that one cannot be checked statically.
 */
const CALL = /\bt\(\s*['"]([a-z0-9_.]+)['"]\s*[),]/g;

/** Doc comments carry `t("key")` as an example; they are not call sites. */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("i18n key usage", () => {
    const used = new Map<string, string>();
    for (const file of sources(ROOT)) {
        const text = stripComments(readFileSync(file, "utf-8"));
        for (const m of text.matchAll(CALL)) {
            if (!used.has(m[1])) used.set(m[1], file.slice(ROOT.length + 1));
        }
    }

    it("finds the translation calls it is meant to check", () => {
        expect(used.size).toBeGreaterThan(300);
    });

    // Nothing renders templates in this suite, so a mistyped key would
    // otherwise only surface as a console.warn on a real device.
    it("every key used in app code exists in both dictionaries", () => {
        const missing: string[] = [];
        for (const [key, file] of used) {
            if (!(key in fr)) missing.push(`${key} (fr) ← ${file}`);
            if (!(key in en)) missing.push(`${key} (en) ← ${file}`);
        }
        expect(missing, `missing translation keys:\n  ${missing.join("\n  ")}`).toEqual([]);
    });
});
