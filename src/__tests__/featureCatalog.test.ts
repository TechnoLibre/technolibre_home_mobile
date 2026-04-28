import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
    FEATURE_TREE,
    type FeatureNode,
} from "../data/featureCatalog";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function flatten(nodes: FeatureNode[]): FeatureNode[] {
    const out: FeatureNode[] = [];
    const walk = (n: FeatureNode) => { out.push(n); n.children?.forEach(walk); };
    nodes.forEach(walk);
    return out;
}

function walkDir(absRoot: string, predicate: (p: string) => boolean): string[] {
    const out: string[] = [];
    const recurse = (dir: string): void => {
        let entries: string[];
        try { entries = readdirSync(dir); } catch { return; }
        for (const name of entries) {
            const abs = `${dir}/${name}`;
            let st;
            try { st = statSync(abs); } catch { continue; }
            if (st.isDirectory()) {
                if (name === "node_modules" || name === "dist" || name === ".git"
                    || name === "build" || name === "__mocks__"
                    || name === "public" || name === "__tests__"
                    || name === ".gradle" || name === "captures"
                    || name === "whisper") continue;
                recurse(abs);
            } else if (predicate(abs)) {
                out.push(relative(ROOT, abs));
            }
        }
    };
    recurse(absRoot);
    return out;
}

describe("featureCatalog", () => {
    const all = flatten(FEATURE_TREE);
    const idSet = new Set(all.map((n) => n.id));
    const cataloguedFiles = new Set<string>();
    for (const n of all) for (const f of n.files ?? []) cataloguedFiles.add(f);

    it("has unique ids", () => {
        const seen = new Set<string>();
        for (const n of all) {
            expect(seen.has(n.id), `duplicate id: ${n.id}`).toBe(false);
            seen.add(n.id);
        }
    });

    it("has bilingual labels everywhere", () => {
        for (const n of all) {
            expect(n.label.fr.length, `missing label.fr for ${n.id}`).toBeGreaterThan(0);
            expect(n.label.en.length, `missing label.en for ${n.id}`).toBeGreaterThan(0);
        }
    });

    it("has bilingual descriptions where present", () => {
        for (const n of all) {
            if (!n.description) continue;
            expect(n.description.fr.length, `missing description.fr for ${n.id}`).toBeGreaterThan(0);
            expect(n.description.en.length, `missing description.en for ${n.id}`).toBeGreaterThan(0);
        }
    });

    it("references files that exist on disk", () => {
        const missing: string[] = [];
        for (const n of all) {
            for (const path of n.files ?? []) {
                if (!existsSync(resolve(ROOT, path))) missing.push(`${n.id} → ${path}`);
            }
        }
        expect(missing, `missing source paths:\n  ${missing.join("\n  ")}`).toEqual([]);
    });

    it("references tests that exist on disk", () => {
        const missing: string[] = [];
        for (const n of all) {
            for (const path of n.tests ?? []) {
                if (!existsSync(resolve(ROOT, path))) missing.push(`${n.id} → ${path}`);
            }
        }
        expect(missing, `missing test paths:\n  ${missing.join("\n  ")}`).toEqual([]);
    });

    it("dependsOn ids resolve to existing nodes", () => {
        const bad: string[] = [];
        for (const n of all) {
            for (const dep of n.dependsOn ?? []) {
                if (!idSet.has(dep)) bad.push(`${n.id} depends on missing id: ${dep}`);
                if (dep === n.id) bad.push(`${n.id} depends on itself`);
            }
        }
        expect(bad, `bad dependsOn refs:\n  ${bad.join("\n  ")}`).toEqual([]);
    });

    it("file paths are relative (no leading slash, no abs)", () => {
        for (const n of all) {
            for (const path of n.files ?? []) {
                expect(path.startsWith("/"), `${n.id}: ${path} has leading slash`).toBe(false);
                expect(path.includes(":"), `${n.id}: ${path} looks absolute`).toBe(false);
            }
        }
    });

    it("ids follow kebab-case[.kebab-case]* pattern", () => {
        const re = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
        for (const n of all) {
            expect(re.test(n.id), `bad id format: ${n.id}`).toBe(true);
        }
    });

    it("every leaf has at least one file", () => {
        for (const n of all) {
            const isLeaf = !n.children || n.children.length === 0;
            if (!isLeaf) continue;
            expect((n.files?.length ?? 0) > 0, `leaf ${n.id} has no files`).toBe(true);
        }
    });

    it("demo of kind 'route' uses an absolute pathname", () => {
        for (const n of all) {
            if (!n.demo || n.demo.kind !== "route") continue;
            expect(n.demo.url.startsWith("/"), `${n.id}: demo url should start with '/'`).toBe(true);
        }
    });

    it("status is one of the documented values", () => {
        const allowed = new Set(["stable", "experimental", "deprecated", "broken"]);
        for (const n of all) {
            if (!n.status) continue;
            expect(allowed.has(n.status), `${n.id}: bad status '${n.status}'`).toBe(true);
        }
    });

    // Files allow-list — entries that genuinely don't belong to any
    // feature (build infra, mocks, vite-env shim, generated, etc).
    const ORPHAN_ALLOWLIST = new Set<string>([
        "src/__owl-precompiled__.ts",
        "src/vite-env.d.ts",
        "src/css/components.scss",   // imports every component scss; meta
        "src/css/mixins.scss",
        "src/css/style.scss",
        "src/data/featureCatalog.ts", // self
        "src/utils/featureSection.ts", // glue for catalog UI
        "src/utils/webViewUtils.ts",   // boot-time WebView shim
        "src/constants/events.ts",     // shared event names
        "src/constants/storage.ts",    // shared localStorage keys
        "src/components/applications/application_mixins.scss", // sass mixins
    ]);

    it("every src/ file is referenced by some feature (or allow-listed)", () => {
        // A `*_component.scss` next to a catalogued `*_component.ts` is
        // implicitly part of the same feature — skip it. Same for
        // `.test.ts` siblings.
        const tsCovered = new Set<string>();
        for (const p of cataloguedFiles) {
            if (p.endsWith(".ts")) tsCovered.add(p.replace(/\.ts$/, ""));
        }
        const isCompanion = (p: string): boolean => {
            const stem = p.replace(/\.(scss|css|test\.ts)$/, "");
            return p !== stem && tsCovered.has(stem);
        };

        const all = walkDir(`${ROOT}/src`, (p) => /\.(ts|scss)$/.test(p));
        const orphans = all
            .map((p) => p.replace(/^\.\//, ""))
            .filter((p) => !cataloguedFiles.has(p)
                && !ORPHAN_ALLOWLIST.has(p)
                && !isCompanion(p));
        expect(
            orphans,
            `\norphan src files (not in any feature, not allow-listed):\n  ${orphans.join("\n  ")}\n`
            + `add them to a feature's files[] in featureCatalog.ts, or to ORPHAN_ALLOWLIST `
            + `in this test file if they are infrastructure.`,
        ).toEqual([]);
    });
});

void statSync;
