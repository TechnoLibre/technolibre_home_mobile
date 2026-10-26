import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPONENTS = join(ROOT, "src", "components");
/** The stylesheet index.html loads; every other sheet hangs off it or off a component's .ts. */
const ENTRY = join(ROOT, "src", "css", "style.scss");

/** Every file under dir whose name ends with suffix, as absolute paths. */
function filesUnder(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, suffix));
    else if (name.endsWith(suffix)) out.push(path);
  }
  return out;
}

/** The text without its comments: block comments, then line comments. */
function uncommented(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * The file a Sass @use names from `from`: the path as written, with .scss
 * added when absent, or its partial (_name.scss); null when none exists.
 */
function sassTarget(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  const withExt = base.endsWith(".scss") ? base : base + ".scss";
  const partial = join(dirname(withExt), "_" + withExt.split("/").pop());
  for (const path of [withExt, partial]) if (existsSync(path)) return path;
  return null;
}

/** The sheets the bundle carries: reached by @use from ENTRY, or imported by a component's .ts, and what those @use. */
function loadedSheets(): Set<string> {
  const pending: string[] = [ENTRY];
  for (const ts of filesUnder(COMPONENTS, ".ts")) {
    for (const m of uncommented(readFileSync(ts, "utf8")).matchAll(/^\s*import\s+["']([^"']+\.scss)["']/gm)) {
      pending.push(resolve(dirname(ts), m[1]));
    }
  }
  const seen = new Set<string>();
  while (pending.length > 0) {
    const sheet = pending.pop()!;
    if (seen.has(sheet) || !existsSync(sheet)) continue;
    seen.add(sheet);
    for (const m of uncommented(readFileSync(sheet, "utf8")).matchAll(/@use\s+["']([^"']+)["']/g)) {
      if (m[1].startsWith("sass:")) continue;
      const target = sassTarget(sheet, m[1]);
      if (target) pending.push(target);
    }
  }
  return seen;
}

describe("component styles", () => {
  it("loads every stylesheet under src/components", () => {
    const loaded = loadedSheets();
    const sheets = filesUnder(COMPONENTS, ".scss");
    expect(sheets.length).toBeGreaterThan(0);
    expect(sheets.filter((s) => !loaded.has(s)).map((s) => relative(ROOT, s))).toEqual([]);
  });

  it("does not count a commented-out @use", () => {
    expect(uncommented('// @use "../a.scss";\n/* @use "../b.scss"; */\n@use "../c.scss";')).not.toMatch(/a\.scss|b\.scss/);
  });
});
