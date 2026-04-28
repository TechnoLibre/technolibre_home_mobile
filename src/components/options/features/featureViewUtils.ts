/**
 * Pure functions backing the Features panel views — extracted so
 * they can be unit-tested without spinning up the Owl component.
 */
import type {
    FeatureNode,
    FeatureI18n,
} from "../../../data/featureCatalog";

export type Lang = "fr" | "en";

export function flatten(nodes: FeatureNode[]): FeatureNode[] {
    const out: FeatureNode[] = [];
    const walk = (n: FeatureNode) => {
        out.push(n);
        n.children?.forEach(walk);
    };
    nodes.forEach(walk);
    return out;
}

export function pickLabel(
    value: FeatureI18n | undefined,
    lang: Lang,
    fallback = "",
): string {
    if (!value) return fallback;
    return value[lang] || value.fr || value.en || fallback;
}

/** Walk the tree to find every ancestor id of `targetId` (excluding
 *  the target itself). Returns null if `targetId` doesn't exist. */
export function ancestorIdsOf(
    targetId: string,
    nodes: FeatureNode[],
): string[] | null {
    const dfs = (list: FeatureNode[], path: string[]): string[] | null => {
        for (const n of list) {
            if (n.id === targetId) return path;
            if (n.children) {
                const r = dfs(n.children, [...path, n.id]);
                if (r !== null) return r;
            }
        }
        return null;
    };
    return dfs(nodes, []);
}

/** Reverse-dependency index: id → ids that declare it in dependsOn. */
export function buildUsedByIndex(
    nodes: FeatureNode[],
): Map<string, string[]> {
    const idx = new Map<string, string[]>();
    for (const n of flatten(nodes)) {
        for (const dep of n.dependsOn ?? []) {
            const list = idx.get(dep) ?? [];
            list.push(n.id);
            idx.set(dep, list);
        }
    }
    return idx;
}

export function subsequence(haystack: string, needle: string): boolean {
    let j = 0;
    for (let i = 0; i < haystack.length && j < needle.length; i++) {
        if (haystack[i] === needle[j]) j++;
    }
    return j === needle.length;
}

/** Scored fuzzy match. Higher = better. 0 = no match. */
export function fuzzyScore(
    node: FeatureNode,
    q: string,
    lang: Lang,
): number {
    if (!q) return 1;
    const qLower = q.toLowerCase();
    let score = 0;
    const hit = (text: string | undefined, weight: number): void => {
        if (!text) return;
        const t = text.toLowerCase();
        const idx = t.indexOf(qLower);
        if (idx === 0) score += weight * 3;
        else if (idx > 0) score += weight * 2;
        else if (subsequence(t, qLower)) score += weight;
    };
    hit(node.id, 8);
    hit(pickLabel(node.label, lang), 6);
    hit(pickLabel(node.description, lang), 3);
    for (const f of node.files ?? []) hit(f, 2);
    hit(pickLabel(node.howItWorks, lang), 1);
    for (const i of node.issues ?? []) hit(pickLabel(i, lang), 1);
    return score;
}

export interface FilterOpts {
    query?: string;
    statusFilter?: string;
    lang?: Lang;
}

/** Leaves only, filtered by status and fuzzy query. */
export function computeFlatLeaves(
    nodes: FeatureNode[],
    opts: FilterOpts = {},
): FeatureNode[] {
    const q = (opts.query ?? "").trim();
    const sf = opts.statusFilter ?? "";
    const lang = opts.lang ?? "fr";
    return flatten(nodes).filter((n) => {
        if (n.children && n.children.length > 0) return false;
        if (sf && (n.status ?? "") !== sf) return false;
        if (q && fuzzyScore(n, q, lang) === 0) return false;
        return true;
    });
}

/** Filtered tree (preserves shape) keeping only branches with at
 *  least one descendant that scores >0 and matches the status filter. */
export function computeFilteredRoots(
    nodes: FeatureNode[],
    opts: FilterOpts = {},
): FeatureNode[] {
    const q = (opts.query ?? "").trim();
    const sf = opts.statusFilter ?? "";
    const lang = opts.lang ?? "fr";
    if (!q && !sf) return nodes;
    const score = (n: FeatureNode): number => {
        const self = q ? fuzzyScore(n, q, lang) : 1;
        if (self === 0) return 0;
        const isLeaf = !n.children || n.children.length === 0;
        if (sf && isLeaf && (n.status ?? "") !== sf) return 0;
        return self;
    };
    const subtree = new Map<string, number>();
    const compute = (n: FeatureNode): number => {
        const self = score(n);
        const childMax = n.children?.reduce((m, c) => Math.max(m, compute(c)), 0) ?? 0;
        const s = Math.max(self, childMax);
        subtree.set(n.id, s);
        return s;
    };
    nodes.forEach(compute);
    const filt = (n: FeatureNode): FeatureNode | null => {
        if ((subtree.get(n.id) ?? 0) === 0) return null;
        const isLeaf = !n.children || n.children.length === 0;
        if (isLeaf) return { ...n };
        const kids = n.children!.map(filt).filter((c): c is FeatureNode => c !== null);
        if (kids.length === 0) return null;
        return { ...n, children: kids };
    };
    return nodes.map(filt).filter((n): n is FeatureNode => n !== null);
}

export interface MatrixRow {
    id: string;
    label: FeatureI18n;
    status: string;
    hasTests: boolean;
    hasHowItWorks: boolean;
    demoKind: string;
    permsCount: number;
    filesCount: number;
    depsCount: number;
}

export function computeMatrix(
    nodes: FeatureNode[],
    opts: FilterOpts = {},
): MatrixRow[] {
    return computeFlatLeaves(nodes, opts).map((n) => ({
        id: n.id,
        label: n.label,
        status: n.status ?? "",
        hasTests: (n.tests?.length ?? 0) > 0,
        hasHowItWorks: !!n.howItWorks,
        demoKind: n.demo ? n.demo.kind : "—",
        permsCount: n.permissions?.length ?? 0,
        filesCount: n.files?.length ?? 0,
        depsCount: n.dependsOn?.length ?? 0,
    }));
}

export interface DashboardData {
    total: number;
    testsCoverage: number;
    howItWorksCoverage: number;
    demoCoverage: number;
    byStatus: Array<{ status: string; count: number; pct: number }>;
    perms: Array<{ name: string; count: number }>;
    missing: Array<{ kind: string; ids: string[] }>;
}

export function computeDashboard(nodes: FeatureNode[]): DashboardData {
    const leaves = flatten(nodes).filter(
        (n) => !n.children || n.children.length === 0,
    );
    const total = leaves.length || 1;
    const pct = (n: number) => Math.round((n / total) * 100);

    const statusCount: Record<string, number> = {};
    const permCount: Record<string, number> = {};
    const missingTests: string[] = [];
    const missingHowItWorks: string[] = [];
    const missingDescription: string[] = [];
    const missingDemo: string[] = [];
    for (const n of leaves) {
        const st = n.status ?? "unknown";
        statusCount[st] = (statusCount[st] ?? 0) + 1;
        for (const p of n.permissions ?? []) permCount[p] = (permCount[p] ?? 0) + 1;
        if (!n.tests || n.tests.length === 0) missingTests.push(n.id);
        if (!n.howItWorks) missingHowItWorks.push(n.id);
        if (!n.description) missingDescription.push(n.id);
        if (!n.demo) missingDemo.push(n.id);
    }

    const order = ["broken", "experimental", "stable", "deprecated", "unknown"];
    const byStatus = order
        .filter((s) => (statusCount[s] ?? 0) > 0)
        .map((status) => ({
            status,
            count: statusCount[status],
            pct: pct(statusCount[status]),
        }));
    const perms = Object.entries(permCount)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

    return {
        total: leaves.length,
        testsCoverage: pct(leaves.length - missingTests.length),
        howItWorksCoverage: pct(leaves.length - missingHowItWorks.length),
        demoCoverage: pct(leaves.length - missingDemo.length),
        byStatus,
        perms,
        missing: [
            { kind: "Sans test", ids: missingTests.slice(0, 20) },
            { kind: "Sans description", ids: missingDescription.slice(0, 20) },
            { kind: "Sans how-it-works", ids: missingHowItWorks.slice(0, 20) },
            { kind: "Sans démo", ids: missingDemo.slice(0, 20) },
        ].filter((g) => g.ids.length > 0),
    };
}

export function computeGraphGroups(
    nodes: FeatureNode[],
    opts: FilterOpts = {},
): Array<{ status: string; nodes: FeatureNode[] }> {
    const order = ["broken", "experimental", "stable", "deprecated", "unknown"];
    const buckets: Record<string, FeatureNode[]> = {};
    for (const k of order) buckets[k] = [];
    const q = (opts.query ?? "").trim();
    const sf = opts.statusFilter ?? "";
    const lang = opts.lang ?? "fr";
    for (const n of flatten(nodes)) {
        if (n.children && n.children.length > 0) continue;
        const status = n.status ?? "unknown";
        if (sf && status !== sf) continue;
        if (q && fuzzyScore(n, q, lang) === 0) continue;
        buckets[status].push(n);
    }
    return order
        .filter((s) => buckets[s].length > 0)
        .map((status) => ({ status, nodes: buckets[status] }));
}
