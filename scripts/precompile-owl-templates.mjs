#!/usr/bin/env node
/**
 * Pre-compile every `xml`...` ` template literal in src/ to a JS function
 * expression bundled in src/__owl-precompiled__.ts. The runtime
 * (src/js/owl-aot.ts) registers each function via App.registerTemplate,
 * bypassing Owl's runtime template compile path — which our CSP
 * (`script-src 'self' 'unsafe-inline'`, no `'unsafe-eval'`) blocks.
 *
 * Skips templates with `${}` interpolation: these are dynamic, can't be
 * compiled at build time, and fall through to Owl's runtime compile.
 *
 * Run automatically by the bundleSourcePlugin in vite.config.ts; or by hand:
 *   node scripts/precompile-owl-templates.mjs
 */

import { JSDOM } from "jsdom";
import {
    readFileSync, writeFileSync, readdirSync, statSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(join(__filename, "..", ".."));
const SRC = join(ROOT, "src");
const OUT = join(SRC, "__owl-precompiled__.ts");

const require = createRequire(import.meta.url);

// ── DOM polyfill (Owl does Element.prototype.* lookups at module load) ─────
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const win = dom.window;
win.requestAnimationFrame = win.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
win.cancelAnimationFrame = win.cancelAnimationFrame || ((id) => clearTimeout(id));
for (const k of Object.getOwnPropertyNames(win)) {
    if (k in global) continue;
    try { global[k] = win[k]; } catch {}
}
global.requestAnimationFrame = win.requestAnimationFrame;
global.cancelAnimationFrame = win.cancelAnimationFrame;

const { App, xml } = require("@odoo/owl");

// One throwaway App used only to drive _compileTemplate.
const app = new App({}, {});

// ── File walk ─────────────────────────────────────────────────────────────
const SKIP_DIRS = new Set([
    "public",      // bundled app source + manifest repos — already-compiled in-tree
    "__mocks__",   // vitest mocks of @odoo/owl etc.
    "__tests__",   // unit test files
    "node_modules",
    "dist",
]);
const SKIP_FILES = new Set(["__owl-precompiled__.ts"]);

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full, out);
        else if (st.isFile() && /\.(tsx?|jsx?)$/.test(name)) out.push(full);
    }
    return out;
}

// ── xml`…` literal extractor ──────────────────────────────────────────────
//
// Hand-rolled scanner — safer than a regex against TS source. Walks the
// string, finds `xml` followed by `` ` ``, then advances to the matching
// closing backtick honoring escapes. Skips templates that contain `${`
// (interpolation) — those would need different handling.
function extractXmlLiterals(source) {
    const out = [];
    let i = 0;
    while (i < source.length) {
        const idx = source.indexOf("xml`", i);
        if (idx < 0) break;
        // Identifier boundary check: the char before must not be alnum/_/$
        const before = idx === 0 ? "" : source[idx - 1];
        if (/[A-Za-z0-9_$]/.test(before)) { i = idx + 4; continue; }
        // Walk past closing backtick
        let j = idx + 4;
        let hasInterpolation = false;
        while (j < source.length) {
            const c = source[j];
            if (c === "\\") { j += 2; continue; }
            if (c === "$" && source[j + 1] === "{") hasInterpolation = true;
            if (c === "`") break;
            j++;
        }
        if (j >= source.length) break;
        if (!hasInterpolation) {
            const xmlStr = source.slice(idx + 4, j);
            out.push(xmlStr);
        }
        i = j + 1;
    }
    return out;
}

function compileOne(xmlStr) {
    // xml() is a tagged template — call manually with a strings array.
    const arr = [xmlStr];
    arr.raw = [xmlStr];
    const name = xml(arr);
    const fn = app._compileTemplate(name, xmlStr);
    return fn.toString();
}

// ── Run ───────────────────────────────────────────────────────────────────
const files = walk(SRC);
const map = new Map(); // xmlStr → fn source
let scanned = 0, compiled = 0, errors = 0, skippedInterpolated = 0;

for (const f of files) {
    scanned++;
    const src = readFileSync(f, "utf-8");
    const xmls = extractXmlLiterals(src);
    for (const x of xmls) {
        if (map.has(x)) continue;
        try {
            map.set(x, compileOne(x));
            compiled++;
        } catch (e) {
            console.error(`[precompile] FAIL ${relative(ROOT, f)}: ${e.message}`);
            errors++;
        }
    }
}

// Recount interpolated by re-scanning
for (const f of files) {
    const src = readFileSync(f, "utf-8");
    const allBackticks = src.match(/[^A-Za-z0-9_$]xml`/g) || [];
    const nonInterpolated = extractXmlLiterals(src).length;
    skippedInterpolated += allBackticks.length - nonInterpolated;
}

// ── Emit ──────────────────────────────────────────────────────────────────
const lines = [
    "// AUTO-GENERATED — do not edit by hand.",
    "// Re-generate via: node scripts/precompile-owl-templates.mjs",
    "//",
    "// Maps each xml`...` template literal source string to a pre-compiled",
    "// JS function expression. The runtime in src/js/owl-aot.ts registers",
    "// each entry on Owl's globalTemplates via App.registerTemplate, so the",
    "// CSP-blocked dynamic-evaluation path inside Owl is never reached.",
    "",
    "/* eslint-disable */",
    "type CompiledTemplate = (app: any, bdom: any, helpers: any) => (",
    "    ctx: unknown, node: unknown, key?: string",
    ") => unknown;",
    "",
    "export const PRECOMPILED: Record<string, CompiledTemplate> = {",
];

let entries = 0;
for (const [xmlStr, fnSrc] of map) {
    if (!fnSrc) continue;
    const keyJson = JSON.stringify(xmlStr);
    // fnSrc is `function anonymous(app, bdom, helpers\n) { ... }` — wrap in
    // parens to disambiguate as expression.
    lines.push(`    ${keyJson}: (${fnSrc}),`);
    entries++;
}
lines.push("};", "");

writeFileSync(OUT, lines.join("\n"));

console.log(
    `[precompile] ${scanned} files scanned, ${compiled} templates compiled, ` +
    `${skippedInterpolated} skipped (interpolation), ${errors} errors → ` +
    `${relative(ROOT, OUT)}`,
);
if (errors > 0) process.exit(1);
