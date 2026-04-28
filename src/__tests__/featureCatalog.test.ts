import { describe, it, expect } from "vitest";
import { existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
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

describe("featureCatalog", () => {
    const all = flatten(FEATURE_TREE);

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
                const abs = resolve(ROOT, path);
                if (!existsSync(abs)) missing.push(`${n.id} → ${path}`);
            }
        }
        expect(missing, `missing source paths:\n  ${missing.join("\n  ")}`).toEqual([]);
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
});

// Mute the `statSync` import warning if it ends up unused after a refactor.
void statSync;
