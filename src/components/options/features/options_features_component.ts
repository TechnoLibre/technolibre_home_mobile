import { onMounted, useState, xml } from "@odoo/owl";
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

// Eagerly-keyed map from `/src/**/*` paths to a loader function. We
// rely on Vite's import.meta.glob ?raw to bundle every TS/SCSS file
// as a string-on-demand chunk. Non-src paths (Java, cpp, vite.config)
// fall through to "not viewable in-app" — the user can still copy
// the path to clipboard and open it on their workstation.
const SRC_RAW_LOADERS = import.meta.glob("/src/**/*.{ts,tsx,scss,css,json,md}", {
    query: "?raw",
    import: "default",
    eager: false,
}) as Record<string, () => Promise<string>>;

function loadSourceFor(relPath: string): Promise<string> | null {
    const key = "/" + relPath;
    const loader = SRC_RAW_LOADERS[key];
    return loader ? loader() : null;
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

function pickLabel(value: FeatureI18n | undefined, lang: Lang, fallback = ""): string {
    if (!value) return fallback;
    return value[lang] || value.fr || value.en || fallback;
}

function demoLabel(demo: FeatureDemo | undefined, lang: Lang): string {
    if (!demo) return "";
    if (demo.kind === "none") return pickLabel(demo.reason, lang, "Pas de démo disponible");
    if (demo.kind === "route") return demo.url;
    if (demo.kind === "options") return demo.sectionId ? `options/${demo.sectionId}` : "options";
    return "";
}

interface State {
    lang: Lang;
    expanded: Set<string>;
    selectedId: string;
    query: string;
    sourcePath: string;
    sourceContent: string;
    sourceError: string;
    counts: { features: number; files: number; demoable: number };
}

export class OptionsFeaturesComponent extends EnhancedComponent {
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
                        <t t-call="OptionsFeaturesNode">
                            <t t-set="node" t-value="root"/>
                            <t t-set="depth" t-value="0"/>
                        </t>
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

            <div t-if="state.sourcePath" class="features__viewer" role="dialog">
                <div class="features__viewer-header">
                    <strong t-esc="state.sourcePath"/>
                    <button t-on-click="onCloseViewer" aria-label="Fermer">✕</button>
                </div>
                <pre t-if="!state.sourceError" class="features__viewer-pre" t-esc="state.sourceContent"/>
                <p t-if="state.sourceError" class="features__viewer-error" t-esc="state.sourceError"/>
            </div>
        </div>

        <t t-name="OptionsFeaturesNode">
            <li role="treeitem"
                t-att-aria-expanded="node.children ? (state.expanded.has(node.id) ? 'true' : 'false') : null"
                t-att-aria-selected="state.selectedId === node.id ? 'true' : 'false'">
                <div class="features__row"
                     t-att-class="{ 'features__row--selected': state.selectedId === node.id }"
                     t-att-style="'padding-left:' + (depth * 1.1 + 0.5) + 'rem'">
                    <button t-if="node.children and node.children.length > 0"
                            class="features__toggle"
                            t-on-click="() => this.onToggle(node.id)">
                        <t t-esc="state.expanded.has(node.id) ? '▾' : '▸'"/>
                    </button>
                    <span t-else="" class="features__toggle-spacer">·</span>
                    <button class="features__label"
                            t-on-click="() => this.onSelect(node.id)">
                        <t t-esc="label(node.label)"/>
                    </button>
                    <span t-if="node.demo and node.demo.kind !== 'none'" class="features__has-demo" aria-hidden="true">▶</span>
                </div>
                <ul t-if="node.children and state.expanded.has(node.id)" role="group">
                    <t t-foreach="node.children" t-as="child" t-key="child.id">
                        <t t-call="OptionsFeaturesNode">
                            <t t-set="node" t-value="child"/>
                            <t t-set="depth" t-value="depth + 1"/>
                        </t>
                    </t>
                </ul>
            </li>
        </t>
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
                || (n.description && pickLabel(n.description, this.state.lang).toLowerCase().includes(q))
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
        this.state = useState<State>({
            lang,
            expanded: new Set(FEATURE_TREE.map((n) => n.id)),  // expand roots by default
            selectedId: "",
            query: "",
            sourcePath: "",
            sourceContent: "",
            sourceError: "",
            counts,
        });
        onMounted(() => { /* nothing async needed at mount */ });
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
        if (this.state.expanded.has(id)) this.state.expanded.delete(id);
        else this.state.expanded.add(id);
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
            // section id can be picked up by OptionsComponent if we
            // wire that in later; for now, just navigate to /options.
            this.eventBus.trigger(Events.ROUTER_NAVIGATION, { url: "/options" });
        }
    }

    async onFileClick(path: string): Promise<void> {
        this.state.sourcePath = path;
        this.state.sourceContent = "";
        this.state.sourceError = "";
        const loader = loadSourceFor(path);
        if (!loader) {
            this.state.sourceError = this.state.lang === "fr"
                ? `Pas visible en-app : ${path}\n(copié, à ouvrir sur ton poste)`
                : `Not viewable in-app: ${path}\n(path copied, open on your machine)`;
            try { await navigator.clipboard?.writeText(path); } catch { /* ignore */ }
            return;
        }
        try {
            this.state.sourceContent = await loader();
        } catch (e) {
            this.state.sourceError = String(e);
        }
    }

    async onCopyPath(path: string): Promise<void> {
        try { await navigator.clipboard?.writeText(path); }
        catch { /* ignore */ }
    }

    onCloseViewer(): void {
        this.state.sourcePath = "";
        this.state.sourceContent = "";
        this.state.sourceError = "";
    }
}
