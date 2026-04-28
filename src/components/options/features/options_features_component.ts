import { Component, onMounted, useState, xml } from "@odoo/owl";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { Events } from "../../../constants/events";
import {
    FEATURE_TREE,
    type FeatureNode,
    type FeatureI18n,
    type FeatureDemo,
} from "../../../data/featureCatalog";

const STORAGE_LANG_KEY = "options.features.lang";
type Lang = "fr" | "en";

/** Pick the right code-bundle target for a path. Files inside src/
 *  are in the mobile bundle (`/repo`); anything else (android/,
 *  vite.config.ts, etc.) lives in the workspace bundle (`/erplibre`)
 *  under the mobile sub-directory. */
function targetAndBundlePath(relPath: string): { target: "mobile" | "erplibre"; path: string } {
    if (relPath.startsWith("src/")) return { target: "mobile", path: relPath };
    return { target: "erplibre", path: `mobile/erplibre_home_mobile/${relPath}` };
}

function flatten(nodes: FeatureNode[]): FeatureNode[] {
    const out: FeatureNode[] = [];
    const walk = (n: FeatureNode) => {
        out.push(n);
        n.children?.forEach(walk);
    };
    nodes.forEach(walk);
    return out;
}

/** Walk the tree to find every ancestor id of `targetId` (excluding
 *  the target itself). Returns null if `targetId` doesn't exist. */
function ancestorIdsOf(targetId: string, nodes: FeatureNode[]): string[] | null {
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

function pickLabel(value: FeatureI18n | undefined, lang: Lang, fallback = ""): string {
    if (!value) return fallback;
    return value[lang] || value.fr || value.en || fallback;
}

interface SharedTreeState {
    lang: Lang;
    /** id → true when expanded. Plain object for Owl 2 reactivity. */
    expanded: Record<string, boolean>;
    selectedId: string;
    /** When non-empty, force-expand every visible node so the user
     *  sees match context regardless of manual collapse state. */
    query: string;
}

interface NodeProps {
    node: FeatureNode;
    depth: number;
    shared: SharedTreeState;
    onToggle: (id: string) => void;
    onSelect: (id: string) => void;
}

class FeatureTreeNodeComponent extends Component<NodeProps> {
    static template = xml`
        <li role="treeitem"
            t-att-aria-expanded="hasChildren ? (isExpanded ? 'true' : 'false') : null"
            t-att-aria-selected="props.shared.selectedId === props.node.id ? 'true' : 'false'">
            <div class="features__row"
                 t-att-class="{ 'features__row--selected': props.shared.selectedId === props.node.id }"
                 t-att-style="rowStyle">
                <button t-if="hasChildren"
                        class="features__toggle"
                        t-on-click="() => this.props.onToggle(this.props.node.id)">
                    <t t-esc="isExpanded ? '▾' : '▸'"/>
                </button>
                <span t-else="" class="features__toggle-spacer">·</span>
                <button class="features__label"
                        t-on-click="() => this.props.onSelect(this.props.node.id)">
                    <t t-esc="labelText"/>
                </button>
                <span t-if="childCount > 0" class="features__count" aria-hidden="true"
                      t-esc="childCount"/>
                <span t-elif="fileCount > 0" class="features__count features__count--files"
                      aria-hidden="true" t-esc="fileCount"/>
                <span t-if="hasDemo" class="features__has-demo" aria-hidden="true">▶</span>
            </div>
            <ul t-if="hasChildren and isExpanded" role="group">
                <t t-foreach="props.node.children" t-as="child" t-key="child.id">
                    <FeatureTreeNodeComponent
                        node="child"
                        depth="props.depth + 1"
                        shared="props.shared"
                        onToggle="props.onToggle"
                        onSelect="props.onSelect"/>
                </t>
            </ul>
        </li>
    `;
    static components = { /* self-reference set below */ };

    get hasChildren(): boolean {
        return !!(this.props.node.children && this.props.node.children.length > 0);
    }
    get childCount(): number {
        return this.props.node.children?.length ?? 0;
    }
    get fileCount(): number {
        return this.props.node.files?.length ?? 0;
    }
    get hasDemo(): boolean {
        return !!(this.props.node.demo && this.props.node.demo.kind !== "none");
    }
    get labelText(): string {
        return pickLabel(this.props.node.label, this.props.shared.lang);
    }
    get rowStyle(): string {
        return `padding-left:${this.props.depth * 1.1 + 0.5}rem`;
    }
    /** Expanded if the user toggled it OR a search is active (we
     *  want every match-ancestor visible without forcing the user
     *  to manually expand on every keystroke). */
    get isExpanded(): boolean {
        if (this.props.shared.query.length > 0) return true;
        return !!this.props.shared.expanded[this.props.node.id];
    }
}
// Owl 2 needs a self-reference for recursive components.
(FeatureTreeNodeComponent as any).components = { FeatureTreeNodeComponent };

interface State extends SharedTreeState {
    query: string;
    counts: { features: number; files: number; demoable: number };
}

export class OptionsFeaturesComponent extends EnhancedComponent {
    static components = { FeatureTreeNodeComponent };

    static template = xml`
        <div id="options-features">
            <div class="features__header">
                <button class="features__back" t-on-click="onBack" aria-label="Retour">←</button>
                <h1>Fonctionnalités</h1>
                <button class="features__lang-toggle"
                        t-on-click="onLangToggle"
                        t-att-aria-label="state.lang === 'fr' ? 'Switch to English' : 'Basculer en français'">
                    <t t-esc="state.lang === 'fr' ? 'EN' : 'FR'" />
                </button>
            </div>

            <div class="features__stats">
                <span><t t-esc="state.counts.features"/> features</span>
                <span class="sep">·</span>
                <span><t t-esc="state.counts.files"/> files</span>
                <span class="sep">·</span>
                <span><t t-esc="state.counts.demoable"/> demos</span>
            </div>

            <input class="features__search"
                   type="search"
                   placeholder="Rechercher…"
                   t-att-value="state.query"
                   t-on-input="onSearch" />

            <div class="features__layout">
                <ul class="features__tree" role="tree" aria-label="Arbre des fonctionnalités">
                    <t t-foreach="filteredRoots" t-as="root" t-key="root.id">
                        <FeatureTreeNodeComponent
                            node="root"
                            depth="0"
                            shared="state"
                            onToggle.bind="onToggle"
                            onSelect.bind="onSelect"/>
                    </t>
                </ul>

                <div class="features__detail" t-if="state.selectedId">
                    <t t-if="selectedNode">
                        <h2 t-esc="label(selectedNode.label)"/>
                        <p t-if="selectedNode.description"
                           class="features__description"
                           t-esc="label(selectedNode.description)"/>
                        <t t-if="selectedNode.howItWorks">
                            <h3>How it works</h3>
                            <p t-esc="label(selectedNode.howItWorks)"/>
                        </t>
                        <t t-if="selectedNode.demo">
                            <h3>Démo</h3>
                            <button class="features__demo-btn"
                                    t-att-disabled="selectedNode.demo.kind === 'none'"
                                    t-on-click="onDemo">
                                <t t-if="selectedNode.demo.kind === 'route'">
                                    Ouvrir <t t-esc="selectedNode.demo.url"/>
                                </t>
                                <t t-if="selectedNode.demo.kind === 'options'">
                                    Ouvrir Options
                                </t>
                                <t t-if="selectedNode.demo.kind === 'none'">
                                    <t t-esc="reasonOf(selectedNode.demo)"/>
                                </t>
                            </button>
                        </t>
                        <t t-if="selectedNode.files and selectedNode.files.length > 0">
                            <h3>Code</h3>
                            <ul class="features__files">
                                <li t-foreach="selectedNode.files" t-as="path" t-key="path">
                                    <button class="features__file"
                                            t-on-click="() => this.onFileClick(path)">
                                        <t t-esc="path"/>
                                    </button>
                                    <button class="features__copy"
                                            t-on-click="() => this.onCopyPath(path)"
                                            aria-label="Copier le chemin">📋</button>
                                </li>
                            </ul>
                        </t>
                    </t>
                </div>
            </div>

        </div>
    `;

    state!: State;

    private get allNodes(): FeatureNode[] {
        return flatten(FEATURE_TREE);
    }

    get selectedNode(): FeatureNode | undefined {
        return this.allNodes.find((n) => n.id === this.state.selectedId);
    }

    get filteredRoots(): FeatureNode[] {
        const q = this.state.query.trim().toLowerCase();
        if (!q) return FEATURE_TREE;
        const matches = (n: FeatureNode): boolean => {
            const hit = pickLabel(n.label, this.state.lang).toLowerCase().includes(q)
                || (!!n.description && pickLabel(n.description, this.state.lang).toLowerCase().includes(q))
                || (n.files?.some((f) => f.toLowerCase().includes(q)) ?? false)
                || n.id.toLowerCase().includes(q);
            const childMatch = n.children?.some(matches) ?? false;
            return hit || childMatch;
        };
        const filterNode = (n: FeatureNode): FeatureNode | null => {
            if (!matches(n)) return null;
            return {
                ...n,
                children: n.children?.map(filterNode).filter((c): c is FeatureNode => c !== null),
            };
        };
        return FEATURE_TREE.map(filterNode).filter((n): n is FeatureNode => n !== null);
    }

    setup() {
        const stored = (typeof localStorage !== "undefined"
            && (localStorage.getItem(STORAGE_LANG_KEY) as Lang | null)) || "fr";
        const lang: Lang = stored === "en" ? "en" : "fr";
        const all = flatten(FEATURE_TREE);
        const counts = {
            features: all.length,
            files: all.reduce((acc, n) => acc + (n.files?.length ?? 0), 0),
            demoable: all.filter((n) => n.demo && n.demo.kind !== "none").length,
        };
        const expandedInit: Record<string, boolean> = {};
        for (const r of FEATURE_TREE) expandedInit[r.id] = true;

        // Deep-link via /options/features?id=<feature-id>: pre-select
        // the feature and expand every ancestor so the row is visible
        // on first paint.
        let initialSelectedId = "";
        try {
            const wantId = new URLSearchParams(window.location.search).get("id");
            if (wantId) {
                const ancestors = ancestorIdsOf(wantId, FEATURE_TREE);
                if (ancestors !== null) {
                    initialSelectedId = wantId;
                    for (const a of ancestors) expandedInit[a] = true;
                }
            }
        } catch { /* ignore — feature still works without deep-link */ }

        this.state = useState<State>({
            lang,
            expanded: expandedInit,
            selectedId: initialSelectedId,
            query: "",
            counts,
        });
        onMounted(() => { /* no-op */ });
    }

    label(value: FeatureI18n | undefined): string {
        return pickLabel(value, this.state.lang);
    }

    reasonOf(demo: FeatureDemo): string {
        if (demo.kind !== "none") return "";
        return pickLabel(demo.reason, this.state.lang, "Pas de démo");
    }

    onBack(): void {
        this.eventBus.trigger(Events.ROUTER_NAVIGATION, { url: "/options" });
    }

    onLangToggle(): void {
        this.state.lang = this.state.lang === "fr" ? "en" : "fr";
        try { localStorage.setItem(STORAGE_LANG_KEY, this.state.lang); } catch { /* ignore */ }
    }

    onSearch(ev: Event): void {
        this.state.query = (ev.target as HTMLInputElement).value;
    }

    onToggle(id: string): void {
        this.state.expanded[id] = !this.state.expanded[id];
    }

    onSelect(id: string): void {
        this.state.selectedId = id;
    }

    onDemo(): void {
        const node = this.selectedNode;
        if (!node?.demo) return;
        if (node.demo.kind === "route") {
            this.eventBus.trigger(Events.ROUTER_NAVIGATION, { url: node.demo.url });
            return;
        }
        if (node.demo.kind === "options") {
            // Pass the sectionId in the URL hash so the matching panel
            // can scroll itself into view and auto-expand on mount.
            const url = node.demo.sectionId
                ? `/options#${node.demo.sectionId}`
                : "/options";
            this.eventBus.trigger(Events.ROUTER_NAVIGATION, { url });
        }
    }

    onFileClick(path: string): void {
        // Hand off to the existing code browser via deep-link query
        // string. Setup() of OptionsCodeComponent picks up the params,
        // auto-connects the right bundle and jumps straight to the
        // file — same UX as if the user navigated there manually.
        const { target, path: bundlePath } = targetAndBundlePath(path);
        const url = `/options/code?target=${target}&path=${encodeURIComponent(bundlePath)}`;
        this.eventBus.trigger(Events.ROUTER_NAVIGATION, { url });
    }

    async onCopyPath(path: string): Promise<void> {
        try { await navigator.clipboard?.writeText(path); }
        catch { /* ignore */ }
    }
}
