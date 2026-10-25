import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPONENTS = join(ROOT, "src", "components");
const ENTRY = join(ROOT, "src", "css", "components.scss");

/** Every *_component.scss under dir, as paths relative to the repo root. */
function componentSheets(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...componentSheets(path));
    else if (name.endsWith("_component.scss")) out.push(relative(ROOT, path));
  }
  return out;
}

/**
 * Whether the bundle loads the sheet: a @use of it in src/css/components.scss
 * (the stylesheet entry), or an import of it from the component's own .ts.
 */
function loaded(sheet: string, entry: string): boolean {
  const fromEntry = "../" + sheet.replace(/^src\//, "");
  if (entry.includes(`@use "${fromEntry}"`)) return true;
  const ts = join(ROOT, sheet.replace(/\.scss$/, ".ts"));
  const file = sheet.split("/").pop()!;
  return existsSync(ts) && readFileSync(ts, "utf8").includes(`import "./${file}"`);
}

describe("component styles", () => {
  it("loads every component stylesheet", () => {
    const entry = readFileSync(ENTRY, "utf8");
    const sheets = componentSheets(COMPONENTS);
    expect(sheets.length).toBeGreaterThan(0);
    expect(sheets.filter((s) => !loaded(s, entry))).toEqual([]);
  });
});
