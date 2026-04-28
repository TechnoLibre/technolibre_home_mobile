import { describe, it, expect } from "vitest";
import type { FeatureNode } from "../data/featureCatalog";
import {
    flatten,
    pickLabel,
    ancestorIdsOf,
    buildUsedByIndex,
    subsequence,
    fuzzyScore,
    computeFlatLeaves,
    computeFilteredRoots,
    computeMatrix,
    computeDashboard,
    computeGraphGroups,
} from "../components/options/features/featureViewUtils";

// Synthetic tree used across tests — small but exercises every
// combination (status, perms, deps, tests, howItWorks, demo kinds).
const TREE: FeatureNode[] = [
    {
        id: "alpha",
        label: { en: "Alpha", fr: "Alpha" },
        children: [
            {
                id: "alpha.one",
                label: { en: "Alpha One", fr: "Alpha Un" },
                description: { en: "first leaf", fr: "première feuille" },
                status: "stable",
                files: ["src/alpha/one.ts"],
                tests: ["src/__tests__/one.test.ts"],
                permissions: ["camera"],
                demo: { kind: "route", url: "/alpha/one" },
                howItWorks: { en: "how it works", fr: "comment ça marche" },
            },
            {
                id: "alpha.two",
                label: { en: "Alpha Two", fr: "Alpha Deux" },
                status: "experimental",
                files: ["src/alpha/two.ts"],
                permissions: ["camera", "microphone"],
                dependsOn: ["alpha.one"],
                demo: { kind: "options", sectionId: "alpha-two" },
            },
        ],
    },
    {
        id: "beta",
        label: { en: "Beta", fr: "Bêta" },
        children: [
            {
                id: "beta.one",
                label: { en: "Beta One", fr: "Bêta Un" },
                description: { en: "third leaf", fr: "troisième feuille" },
                status: "broken",
                files: ["src/beta/one.ts"],
                demo: { kind: "none", reason: { en: "—", fr: "—" } },
            },
        ],
    },
];

describe("flatten", () => {
    it("returns every node depth-first", () => {
        const ids = flatten(TREE).map((n) => n.id);
        expect(ids).toEqual(["alpha", "alpha.one", "alpha.two", "beta", "beta.one"]);
    });
});

describe("pickLabel", () => {
    it("picks the requested language", () => {
        expect(pickLabel({ en: "Hi", fr: "Salut" }, "fr")).toBe("Salut");
        expect(pickLabel({ en: "Hi", fr: "Salut" }, "en")).toBe("Hi");
    });
    it("falls back to the other language if requested is empty", () => {
        expect(pickLabel({ en: "Hi", fr: "" }, "fr")).toBe("Hi");
        expect(pickLabel({ en: "", fr: "Salut" }, "en")).toBe("Salut");
    });
    it("uses the fallback string when nothing matches", () => {
        expect(pickLabel(undefined, "fr", "—")).toBe("—");
    });
});

describe("ancestorIdsOf", () => {
    it("returns empty path for a root node", () => {
        expect(ancestorIdsOf("alpha", TREE)).toEqual([]);
    });
    it("returns the chain of parent ids for a deep node", () => {
        expect(ancestorIdsOf("alpha.two", TREE)).toEqual(["alpha"]);
    });
    it("returns null for a missing id", () => {
        expect(ancestorIdsOf("nope", TREE)).toBeNull();
    });
});

describe("buildUsedByIndex", () => {
    it("maps each id to the list of its dependents", () => {
        const idx = buildUsedByIndex(TREE);
        expect(idx.get("alpha.one")).toEqual(["alpha.two"]);
        expect(idx.get("alpha.two")).toBeUndefined();
    });
});

describe("subsequence", () => {
    it("returns true when the needle's chars appear in order", () => {
        expect(subsequence("hello world", "hwd")).toBe(true);
    });
    it("returns false when order is broken", () => {
        expect(subsequence("hello", "lh")).toBe(false);
    });
    it("returns true for empty needle", () => {
        expect(subsequence("anything", "")).toBe(true);
    });
});

describe("fuzzyScore", () => {
    const node = TREE[0].children![0]; // alpha.one

    it("returns 1 for empty query (everything matches)", () => {
        expect(fuzzyScore(node, "", "fr")).toBeGreaterThan(0);
    });

    it("scores a prefix match higher than a substring match", () => {
        const prefix = fuzzyScore(node, "alpha", "fr");
        const sub = fuzzyScore(node, "pha", "fr");
        expect(prefix).toBeGreaterThan(sub);
    });

    it("returns 0 when nothing matches", () => {
        expect(fuzzyScore(node, "zzzzznopezz", "fr")).toBe(0);
    });

    it("matches a subsequence with a non-zero score", () => {
        // 'aone' is a subsequence of 'alpha.one'
        expect(fuzzyScore(node, "aone", "fr")).toBeGreaterThan(0);
    });
});

describe("computeFlatLeaves", () => {
    it("returns leaves only", () => {
        const ids = computeFlatLeaves(TREE).map((n) => n.id);
        expect(ids).toEqual(["alpha.one", "alpha.two", "beta.one"]);
    });
    it("filters by status", () => {
        const ids = computeFlatLeaves(TREE, { statusFilter: "broken" }).map((n) => n.id);
        expect(ids).toEqual(["beta.one"]);
    });
    it("filters by fuzzy query", () => {
        const ids = computeFlatLeaves(TREE, { query: "beta" }).map((n) => n.id);
        expect(ids).toEqual(["beta.one"]);
    });
});

describe("computeFilteredRoots", () => {
    it("returns the original tree when no filters set", () => {
        expect(computeFilteredRoots(TREE)).toBe(TREE);
    });
    it("prunes branches with no matches", () => {
        const result = computeFilteredRoots(TREE, { query: "beta" });
        expect(result.map((n) => n.id)).toEqual(["beta"]);
        expect(result[0].children?.map((c) => c.id)).toEqual(["beta.one"]);
    });
    it("keeps a branch when any descendant matches", () => {
        const result = computeFilteredRoots(TREE, { query: "alpha.two" });
        expect(result.map((n) => n.id)).toEqual(["alpha"]);
        expect(result[0].children?.map((c) => c.id)).toEqual(["alpha.two"]);
    });
    it("status filter only constrains leaves", () => {
        const result = computeFilteredRoots(TREE, { statusFilter: "experimental" });
        expect(result.map((n) => n.id)).toEqual(["alpha"]);
        expect(result[0].children?.map((c) => c.id)).toEqual(["alpha.two"]);
    });
});

describe("computeMatrix", () => {
    it("flattens leaves with all attribute presence flags", () => {
        const rows = computeMatrix(TREE);
        expect(rows).toHaveLength(3);

        const one = rows.find((r) => r.id === "alpha.one")!;
        expect(one.hasTests).toBe(true);
        expect(one.hasHowItWorks).toBe(true);
        expect(one.demoKind).toBe("route");
        expect(one.permsCount).toBe(1);
        expect(one.filesCount).toBe(1);
        expect(one.depsCount).toBe(0);
        expect(one.status).toBe("stable");

        const two = rows.find((r) => r.id === "alpha.two")!;
        expect(two.hasTests).toBe(false);
        expect(two.demoKind).toBe("options");
        expect(two.depsCount).toBe(1);
    });
});

describe("computeDashboard", () => {
    it("counts leaves and computes percentages", () => {
        const d = computeDashboard(TREE);
        expect(d.total).toBe(3);
        // 1 of 3 has tests = 33%
        expect(d.testsCoverage).toBe(33);
        // 1 of 3 has howItWorks = 33%
        expect(d.howItWorksCoverage).toBe(33);
        // 3 of 3 have a demo (route, options, none) = 100%
        expect(d.demoCoverage).toBe(100);
    });

    it("groups by status with percentages summing to ≤100", () => {
        const d = computeDashboard(TREE);
        const sum = d.byStatus.reduce((s, r) => s + r.pct, 0);
        expect(sum).toBeLessThanOrEqual(100);
        const labels = d.byStatus.map((r) => r.status);
        expect(labels).toContain("stable");
        expect(labels).toContain("experimental");
        expect(labels).toContain("broken");
    });

    it("aggregates permissions sorted by count", () => {
        const d = computeDashboard(TREE);
        // camera in 2 nodes, microphone in 1
        const camera = d.perms.find((p) => p.name === "camera")!;
        const mic = d.perms.find((p) => p.name === "microphone")!;
        expect(camera.count).toBe(2);
        expect(mic.count).toBe(1);
        expect(d.perms[0].name).toBe("camera"); // sorted
    });

    it("emits 'missing' groups only when non-empty", () => {
        const d = computeDashboard(TREE);
        const kinds = d.missing.map((g) => g.kind);
        expect(kinds).toContain("Sans test");
        expect(kinds).toContain("Sans how-it-works");
        // every leaf has a description in our fixture? alpha.two has none
        expect(d.missing.find((g) => g.kind === "Sans description")?.ids)
            .toContain("alpha.two");
    });
});

describe("computeGraphGroups", () => {
    it("groups leaves by status in the documented order", () => {
        const groups = computeGraphGroups(TREE);
        expect(groups.map((g) => g.status)).toEqual(["broken", "experimental", "stable"]);
    });

    it("respects status filter", () => {
        const groups = computeGraphGroups(TREE, { statusFilter: "broken" });
        expect(groups).toHaveLength(1);
        expect(groups[0].nodes.map((n) => n.id)).toEqual(["beta.one"]);
    });

    it("respects fuzzy query", () => {
        const groups = computeGraphGroups(TREE, { query: "alpha.one" });
        expect(groups.flatMap((g) => g.nodes.map((n) => n.id))).toEqual(["alpha.one"]);
    });
});
