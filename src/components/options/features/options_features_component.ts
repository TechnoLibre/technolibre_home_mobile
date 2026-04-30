import { Component, onMounted, useState, xml } from "@odoo/owl";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { Events } from "../../../constants/events";
import {
    FEATURE_TREE,
    type FeatureNode,
    type FeatureI18n,
    type FeatureDemo,
} from "../../../data/featureCatalog";
import {
    type Lang,
    flatten,
    pickLabel,
    ancestorIdsOf,
    buildUsedByIndex,
    fuzzyScore,
    computeFlatLeaves,
    computeFilteredRoots,
    computeMatrix,
    computeDashboard,
    computeFreshness,
    type FreshnessData,
    computeGraphGroups,
    type MatrixRow,
    type DashboardData,
} from "./featureViewUtils";

const STORAGE_LANG_KEY = "options.features.lang";

/** Pick the right code-bundle target for a path. Files inside src/
 *  are in the mobile bundle (`/repo`); anything else (android/,
 *  vite.config.ts, etc.) lives in the workspace bundle (`/erplibre`)
 *  under the mobile sub-directory. */
function targetAndBundlePath(relPath: string): { target: "mobile" | "erplibre"; path: string } {
    if (relPath.startsWith("src/")) return { target: "mobile", path: relPath };
    return { target: "erplibre", path: `mobile/erplibre_home_mobile/${relPath}` };
}

const STATUS_LABEL: Record<string, FeatureI18n> = {
    stable:       { en: "Stable",       fr: "Stable" },
    experimental: { en: "Experimental", fr: "Expérimental" },
    deprecated:   { en: "Deprecated",   fr: "Déprécié" },
    broken:       { en: "Broken",       fr: "Cassé" },
};

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
                <span t-if="statusBadge" class="features__status"
                      t-att-class="'features__status--' + statusBadge"
                      aria-hidden="true"/>
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

    get statusBadge(): string {
        return this.props.node.status ?? "";
    }
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

type ViewMode = "tree" | "graph" | "matrix" | "cards" | "dashboard";

interface State extends SharedTreeState {
    query: string;
    counts: { features: number; files: number; demoable: number };
    view: ViewMode;
    /** Whether the "view picker" menu (the … button) is expanded. */
    viewMenuOpen: boolean;
    /** Optional status filter (empty string = no filter). */
    statusFilter: string;
    /** Map id → { ts, iso } loaded from feature_touched.json at build.
     *  Empty until fetch resolves; computeFreshness handles the gap. */
    touched: Record<string, { ts: number; iso: string }>;
}

const VIEW_LABELS: Record<ViewMode, FeatureI18n> = {
    tree:      { en: "Tree",      fr: "Arbre" },
    graph:     { en: "Graph",     fr: "Graphe" },
    matrix:    { en: "Matrix",    fr: "Matrice" },
    cards:     { en: "Cards",     fr: "Cartes" },
    dashboard: { en: "Dashboard", fr: "Tableau" },
};

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

            <div class="features__filters">
                <input class="features__search"
                       type="search"
                       placeholder="Rechercher (fuzzy)…"
                       t-att-value="state.query"
                       t-on-input="onSearch" />
                <select class="features__status-filter"
                        t-att-value="state.statusFilter"
                        t-on-change="onStatusFilterChange">
                    <option value="">Tous statuts</option>
                    <option value="stable">Stable</option>
                    <option value="experimental">Expérimental</option>
                    <option value="deprecated">Déprécié</option>
                    <option value="broken">Cassé</option>
                </select>
                <div class="features__view-picker">
                    <button class="features__view-picker-btn"
                            t-att-aria-expanded="state.viewMenuOpen ? 'true' : 'false'"
                            aria-haspopup="menu"
                            t-on-click="onToggleViewMenu">
                        <t t-esc="currentViewLabel"/> ⋯
                    </button>
                    <ul t-if="state.viewMenuOpen" class="features__view-menu" role="menu">
                        <li t-foreach="viewModes" t-as="mode" t-key="mode" role="menuitem"
                            t-att-class="{ 'features__view-menu-item--active': state.view === mode }">
                            <button t-on-click="() => this.onViewChange(mode)">
                                <t t-esc="viewLabel(mode)"/>
                            </button>
                        </li>
                    </ul>
                </div>
            </div>

            <div class="features__layout">
                <ul t-if="state.view === 'tree'"
                    class="features__tree" role="tree" aria-label="Arbre des fonctionnalités">
                    <t t-foreach="filteredRoots" t-as="root" t-key="root.id">
                        <FeatureTreeNodeComponent
                            node="root"
                            depth="0"
                            shared="state"
                            onToggle.bind="onToggle"
                            onSelect.bind="onSelect"/>
                    </t>
                </ul>

                <div t-elif="state.view === 'matrix'" class="features__matrix-wrap">
                    <table class="features__matrix">
                        <thead>
                            <tr>
                                <th>Feature</th>
                                <th>Status</th>
                                <th>Tests</th>
                                <th>Doc</th>
                                <th>Démo</th>
                                <th>Perms</th>
                                <th>Files</th>
                                <th>Deps</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr t-foreach="matrixRows" t-as="row" t-key="row.id"
                                t-att-class="{ 'features__matrix-row--selected': state.selectedId === row.id }"
                                t-on-click="() => this.onSelect(row.id)">
                                <td class="features__matrix-label">
                                    <span t-if="row.status" class="features__status"
                                          t-att-class="'features__status--' + row.status"
                                          aria-hidden="true"/>
                                    <t t-esc="label(row.label)"/>
                                </td>
                                <td t-att-class="'features__matrix-status features__matrix-status--' + (row.status or 'none')"
                                    t-esc="row.status or '—'"/>
                                <td t-att-class="row.hasTests ? 'features__matrix-yes' : 'features__matrix-no'"
                                    t-esc="row.hasTests ? '✓' : '—'"/>
                                <td t-att-class="row.hasHowItWorks ? 'features__matrix-yes' : 'features__matrix-no'"
                                    t-esc="row.hasHowItWorks ? '✓' : '—'"/>
                                <td t-att-class="row.demoKind === 'none' ? 'features__matrix-no' : 'features__matrix-yes'"
                                    t-esc="row.demoKind"/>
                                <td t-esc="row.permsCount or '—'"/>
                                <td t-esc="row.filesCount or '—'"/>
                                <td t-esc="row.depsCount or '—'"/>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <div t-elif="state.view === 'cards'" class="features__cards"
                     aria-label="Vue cartes">
                    <article t-foreach="cardItems" t-as="card" t-key="card.id"
                             class="features__card"
                             t-att-class="{ 'features__card--selected': state.selectedId === card.id }"
                             t-on-click="() => this.onSelect(card.id)">
                        <header class="features__card-head">
                            <h3 t-esc="label(card.label)"/>
                            <span t-if="card.status"
                                  class="features__status-chip"
                                  t-att-class="'features__status-chip--' + card.status">
                                <t t-esc="statusLabel(card.status)"/>
                            </span>
                        </header>
                        <p t-if="card.description"
                           class="features__card-desc"
                           t-esc="label(card.description)"/>
                        <div t-if="card.permissions and card.permissions.length > 0"
                             class="features__perms">
                            <span t-foreach="card.permissions" t-as="perm" t-key="perm"
                                  class="features__perm-chip" t-esc="perm"/>
                        </div>
                        <footer class="features__card-foot">
                            <span t-if="card.files and card.files.length > 0">
                                📄 <t t-esc="card.files.length"/>
                            </span>
                            <span t-if="card.tests and card.tests.length > 0">
                                🧪 <t t-esc="card.tests.length"/>
                            </span>
                            <span t-if="card.dependsOn and card.dependsOn.length > 0">
                                🔗 <t t-esc="card.dependsOn.length"/>
                            </span>
                            <span t-if="card.demo and card.demo.kind !== 'none'">▶ démo</span>
                        </footer>
                    </article>
                </div>

                <div t-elif="state.view === 'dashboard'" class="features__dashboard"
                     aria-label="Tableau de bord">
                    <div class="features__dashboard-grid">
                        <div class="features__stat">
                            <div class="features__stat-num" t-esc="dashboard.total"/>
                            <div class="features__stat-label">Features</div>
                        </div>
                        <div class="features__stat">
                            <div class="features__stat-num" t-esc="dashboard.testsCoverage + '%'"/>
                            <div class="features__stat-label">Avec tests</div>
                        </div>
                        <div class="features__stat">
                            <div class="features__stat-num" t-esc="dashboard.howItWorksCoverage + '%'"/>
                            <div class="features__stat-label">Documentées</div>
                        </div>
                        <div class="features__stat">
                            <div class="features__stat-num" t-esc="dashboard.demoCoverage + '%'"/>
                            <div class="features__stat-label">Démontrables</div>
                        </div>
                    </div>

                    <h3>Statut</h3>
                    <div class="features__bar-chart">
                        <div t-foreach="dashboard.byStatus" t-as="row" t-key="row.status"
                             class="features__bar-row">
                            <span class="features__bar-label">
                                <span class="features__status"
                                      t-att-class="'features__status--' + row.status"
                                      aria-hidden="true"/>
                                <t t-esc="statusLabel(row.status)"/>
                            </span>
                            <div class="features__bar"
                                 t-att-style="'width:' + row.pct + '%'"
                                 t-att-class="'features__bar--' + row.status"/>
                            <span class="features__bar-num" t-esc="row.count"/>
                        </div>
                    </div>

                    <h3>Permissions utilisées</h3>
                    <div class="features__perms">
                        <span t-foreach="dashboard.perms" t-as="p" t-key="p.name"
                              class="features__perm-chip">
                            <t t-esc="p.name"/> <small>(<t t-esc="p.count"/>)</small>
                        </span>
                    </div>

                    <h3>À compléter</h3>
                    <ul class="features__todo">
                        <li t-foreach="dashboard.missing" t-as="grp" t-key="grp.kind">
                            <strong t-esc="grp.kind"/> (<t t-esc="grp.ids.length"/>):
                            <span t-foreach="grp.ids" t-as="id" t-key="id"
                                  class="features__todo-id">
                                <button class="features__dep"
                                        t-on-click="() => this.onSelect(id)"
                                        t-esc="id"/>
                            </span>
                        </li>
                    </ul>

                    <h3>Fraîcheur (dernier commit par feature)</h3>
                    <div class="features__bar-chart">
                        <div t-foreach="freshness.buckets" t-as="b" t-key="b.kind"
                             class="features__bar-row">
                            <span class="features__bar-label" t-esc="b.kind"/>
                            <div class="features__bar"
                                 t-att-style="'width:' + (b.count * 100 / dashboard.total) + '%'"/>
                            <span class="features__bar-num" t-esc="b.count"/>
                        </div>
                    </div>

                    <h3>Top 10 features les plus anciennes</h3>
                    <ul class="features__todo">
                        <li t-foreach="freshness.staleest" t-as="row" t-key="row.id">
                            <button class="features__dep"
                                    t-on-click="() => this.onSelect(row.id)"
                                    t-esc="row.id"/>
                            <span class="features__bar-num">
                                <t t-esc="row.ageDays"/> j
                            </span>
                        </li>
                    </ul>
                </div>

                <div t-elif="state.view === 'graph'" class="features__graph"
                     aria-label="Vue graphe par statut">
                    <t t-foreach="graphGroups" t-as="grp" t-key="grp.status">
                        <div class="features__graph-group">
                            <h3 class="features__graph-status"
                                t-att-class="'features__graph-status--' + grp.status">
                                <span class="features__status"
                                      t-att-class="'features__status--' + grp.status"
                                      aria-hidden="true"/>
                                <t t-esc="statusLabel(grp.status)"/>
                                <span class="features__graph-count" t-esc="grp.nodes.length"/>
                            </h3>
                            <ul class="features__graph-list">
                                <li t-foreach="grp.nodes" t-as="n" t-key="n.id"
                                    class="features__graph-node"
                                    t-att-class="{ 'features__graph-node--selected': state.selectedId === n.id }">
                                    <button class="features__label"
                                            t-on-click="() => this.onSelect(n.id)">
                                        <t t-esc="label(n.label)"/>
                                    </button>
                                    <t t-if="n.dependsOn and n.dependsOn.length > 0">
                                        <span class="features__graph-arrow" aria-hidden="true">→</span>
                                        <span class="features__graph-deps">
                                            <t t-foreach="n.dependsOn" t-as="depId" t-key="depId">
                                                <button class="features__dep"
                                                        t-on-click="() => this.onSelect(depId)">
                                                    <t t-esc="labelOfId(depId)"/>
                                                </button><t t-if="!depId_last">, </t>
                                            </t>
                                        </span>
                                    </t>
                                </li>
                            </ul>
                        </div>
                    </t>
                </div>

                <div class="features__detail" t-if="state.selectedId">
                    <t t-if="selectedNode">
                        <div class="features__detail-head">
                            <h2 t-esc="label(selectedNode.label)"/>
                            <span t-if="selectedNode.status"
                                  class="features__status-chip"
                                  t-att-class="'features__status-chip--' + selectedNode.status">
                                <t t-esc="statusLabel(selectedNode.status)"/>
                            </span>
                            <button class="features__detail-close"
                                    aria-label="Fermer le détail"
                                    t-on-click="onCloseDetail">✕</button>
                        </div>
                        <p t-if="selectedNode.description"
                           class="features__description"
                           t-esc="label(selectedNode.description)"/>

                        <t t-if="selectedNode.permissions and selectedNode.permissions.length > 0">
                            <h3>Permissions</h3>
                            <div class="features__perms">
                                <span t-foreach="selectedNode.permissions" t-as="perm" t-key="perm"
                                      class="features__perm-chip" t-esc="perm"/>
                            </div>
                        </t>

                        <t t-if="selectedNode.howItWorks">
                            <h3>How it works</h3>
                            <p t-esc="label(selectedNode.howItWorks)"/>
                        </t>

                        <t t-if="selectedNode.issues and selectedNode.issues.length > 0">
                            <h3>Limitations connues</h3>
                            <ul class="features__issues">
                                <li t-foreach="selectedNode.issues" t-as="issue" t-key="issue_index"
                                    t-esc="label(issue)"/>
                            </ul>
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

                        <t t-if="selectedNode.tests and selectedNode.tests.length > 0">
                            <h3>Tests</h3>
                            <ul class="features__files">
                                <li t-foreach="selectedNode.tests" t-as="path" t-key="path">
                                    <button class="features__file"
                                            t-on-click="() => this.onFileClick(path)">
                                        <t t-esc="path"/>
                                    </button>
                                </li>
                            </ul>
                        </t>

                        <t t-if="selectedNode.dependsOn and selectedNode.dependsOn.length > 0">
                            <h3>Dépend de</h3>
                            <ul class="features__deps">
                                <li t-foreach="selectedNode.dependsOn" t-as="depId" t-key="depId">
                                    <button class="features__dep"
                                            t-on-click="() => this.onSelect(depId)">
                                        <t t-esc="labelOfId(depId)"/>
                                    </button>
                                </li>
                            </ul>
                        </t>

                        <t t-if="usedByIds.length > 0">
                            <h3>Utilisé par</h3>
                            <ul class="features__deps">
                                <li t-foreach="usedByIds" t-as="depId" t-key="depId">
                                    <button class="features__dep"
                                            t-on-click="() => this.onSelect(depId)">
                                        <t t-esc="labelOfId(depId)"/>
                                    </button>
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
        return computeFilteredRoots(FEATURE_TREE, {
            query: this.state.query,
            statusFilter: this.state.statusFilter,
            lang: this.state.lang,
        });
    }

    /** Reverse-dep map for the currently-selected node only.
     *  Cheap (one walk) and avoids passing the whole index around. */
    get usedByIds(): string[] {
        if (!this.state.selectedId) return [];
        return buildUsedByIndex(FEATURE_TREE).get(this.state.selectedId) ?? [];
    }

    /** All view modes in display order. Used by the dropdown menu. */
    get viewModes(): string[] {
        return ["tree", "graph", "matrix", "cards", "dashboard"];
    }

    get currentViewLabel(): string {
        return pickLabel(VIEW_LABELS[this.state.view], this.state.lang, this.state.view);
    }

    viewLabel(mode: string): string {
        const v = VIEW_LABELS[mode as ViewMode];
        return pickLabel(v, this.state.lang, mode);
    }

    private get filterOpts() {
        return {
            query: this.state.query,
            statusFilter: this.state.statusFilter,
            lang: this.state.lang,
        };
    }

    get flatLeavesFiltered(): FeatureNode[] {
        return computeFlatLeaves(FEATURE_TREE, this.filterOpts);
    }

    get matrixRows(): MatrixRow[] {
        return computeMatrix(FEATURE_TREE, this.filterOpts);
    }

    get cardItems(): FeatureNode[] {
        return this.flatLeavesFiltered;
    }

    get dashboard(): DashboardData {
        return computeDashboard(FEATURE_TREE);
    }

    get freshness(): FreshnessData {
        return computeFreshness(FEATURE_TREE, this.state.touched);
    }

    /** Pretty age label for a touched-on entry. Falls back to '—'. */
    ageOfId(id: string): string {
        const t = this.state.touched[id]?.ts;
        if (!t) return "—";
        const days = Math.floor((Date.now() - t) / (86400 * 1000));
        if (days === 0) return "aujourd'hui";
        if (days === 1) return "hier";
        if (days < 30) return `il y a ${days} j`;
        if (days < 365) return `il y a ${Math.floor(days / 30)} mois`;
        return `il y a ${Math.floor(days / 365)} an(s)`;
    }

    get graphGroups(): { status: string; nodes: FeatureNode[] }[] {
        return computeGraphGroups(FEATURE_TREE, this.filterOpts);
    }

    nodeById(id: string): FeatureNode | undefined {
        return this.allNodes.find((n) => n.id === id);
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
            view: "tree",
            viewMenuOpen: false,
            statusFilter: "",
            touched: {},
        });
        onMounted(() => {
            // Last-touched timestamps generated by the vite build plugin
            // (feature-touched). Best-effort fetch — dashboard handles
            // the empty state cleanly.
            fetch("/feature_touched.json")
                .then((r) => (r.ok ? r.json() : {}))
                .then((data) => { this.state.touched = data; })
                .catch(() => { /* keep empty */ });
        });
    }

    label(value: FeatureI18n | undefined): string {
        return pickLabel(value, this.state.lang);
    }

    labelOfId(id: string): string {
        const n = this.nodeById(id);
        return n ? pickLabel(n.label, this.state.lang) : id;
    }

    statusLabel(status: string): string {
        return pickLabel(STATUS_LABEL[status], this.state.lang, status);
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

    onStatusFilterChange(ev: Event): void {
        this.state.statusFilter = (ev.target as HTMLSelectElement).value;
    }

    onViewChange(view: ViewMode | string): void {
        this.state.view = view as ViewMode;
        this.state.viewMenuOpen = false;
    }

    onToggleViewMenu(): void {
        this.state.viewMenuOpen = !this.state.viewMenuOpen;
    }

    onToggle(id: string): void {
        this.state.expanded[id] = !this.state.expanded[id];
    }

    onSelect(id: string): void {
        this.state.selectedId = id;
    }

    onCloseDetail(): void {
        this.state.selectedId = "";
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
