import { onWillDestroy, useState, xml } from "@odoo/owl";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { HeadingComponent } from "../../heading/heading_component";
import { CodeService, DirEntry, GitBranch, GitCommit } from "../../../services/codeService";
import { BundleCodeService } from "../../../services/bundleCodeService";
import { RepoFs, getRepoFs } from "../../../services/repoFsFactory";
import { ManifestProject as ManifestProjectModel } from "../../../models/manifestProject";
import {
    detectFileLang, imageMime, supportsHighlight, highlightLine, FileLang,
} from "./syntax_highlight";
import { Server } from "../../../models/server";
import { Workspace } from "../../../models/workspace";
import { Note } from "../../../models/note";

type Mode = "bundle" | "ssh-path" | "ssh-url";
type Phase = "setup" | "browser";
type BrowserTab = "files" | "git";
type FileViewMode = "code" | "markdown" | "image";

type ManifestProject = ManifestProjectModel;

// ── Markdown renderer ─────────────────────────────────────────────────────────

function escHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function applyInline(s: string): string {
    return s
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>")
        .replace(/`(.+?)`/g, '<code class="md-inline-code">$1</code>')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '<span class="md-link">$1</span>');
}

function renderMarkdown(text: string): string {
    const lines = text.split("\n");
    const out: string[] = [];
    let inCode = false;
    let codeLines: string[] = [];
    let codeLang = "";

    for (const raw of lines) {
        if (raw.startsWith("```")) {
            if (inCode) {
                out.push(
                    `<pre class="md-code-block" data-lang="${escHtml(codeLang)}"><code>${escHtml(codeLines.join("\n"))}</code></pre>`,
                );
                codeLines = [];
                codeLang = "";
                inCode = false;
            } else {
                codeLang = raw.slice(3).trim();
                inCode = true;
            }
            continue;
        }
        if (inCode) { codeLines.push(raw); continue; }

        const l = escHtml(raw);
        if (l.startsWith("### "))       out.push(`<h3 class="md-h3">${applyInline(l.slice(4))}</h3>`);
        else if (l.startsWith("## "))   out.push(`<h2 class="md-h2">${applyInline(l.slice(3))}</h2>`);
        else if (l.startsWith("# "))    out.push(`<h1 class="md-h1">${applyInline(l.slice(2))}</h1>`);
        else if (l === "---" || l === "***" || l === "___") out.push('<hr class="md-hr" />');
        else if (l.startsWith("- ") || l.startsWith("* ")) out.push(`<div class="md-li">•&nbsp;${applyInline(l.slice(2))}</div>`);
        else if (/^\d+\. /.test(l)) {
            const m = l.match(/^(\d+)\. (.*)/);
            if (m) out.push(`<div class="md-li">${m[1]}.&nbsp;${applyInline(m[2])}</div>`);
        } else if (l.startsWith("&gt; ")) {
            out.push(`<blockquote class="md-blockquote">${applyInline(l.slice(5))}</blockquote>`);
        } else if (l === "") {
            out.push('<div class="md-spacer"></div>');
        } else {
            out.push(`<p class="md-p">${applyInline(l)}</p>`);
        }
    }
    if (inCode && codeLines.length > 0) {
        out.push(`<pre class="md-code-block"><code>${escHtml(codeLines.join("\n"))}</code></pre>`);
    }
    return out.join("");
}

// ── Component ─────────────────────────────────────────────────────────────────

export class OptionsCodeComponent extends EnhancedComponent {
    static template = xml`
<div id="options-code-component">
  <HeadingComponent title="'Code'" />

  <!-- ══════════════════ SETUP ══════════════════ -->
  <t t-if="state.phase === 'setup'">
    <div class="code-setup">

      <!-- Mode selector -->
      <div class="code-setup__label">Mode</div>
      <div class="code-setup__mode-row">
        <button class="code-setup__mode-btn"
                t-att-class="{ 'code-setup__mode-btn--active': state.mode === 'bundle' }"
                t-on-click="() => this.onModeChange('bundle')">
          📦 Bundle
        </button>
        <button class="code-setup__mode-btn"
                t-att-class="{ 'code-setup__mode-btn--active': state.mode === 'ssh-path' }"
                t-on-click="() => this.onModeChange('ssh-path')">
          🖥 SSH Chemin
        </button>
        <button class="code-setup__mode-btn"
                t-att-class="{ 'code-setup__mode-btn--active': state.mode === 'ssh-url' }"
                t-on-click="() => this.onModeChange('ssh-url')">
          🔗 Git URL
        </button>
      </div>

      <t t-if="state.mode === 'bundle'">
        <div class="code-setup__hint">Sources embarquées à la compilation. Lecture seule, aucun serveur requis.</div>
      </t>
      <t t-if="state.mode === 'ssh-path'">
        <div class="code-setup__hint">Naviguez un workspace sur un serveur SSH.</div>
      </t>
      <t t-if="state.mode === 'ssh-url'">
        <div class="code-setup__hint">Naviguez un dépôt git du manifest ERPLibre (embarqué à la compilation).</div>
      </t>

      <!-- ── SSH PATH ── -->
      <t t-if="state.mode === 'ssh-path'">
        <div class="code-setup__label">Serveur SSH</div>
        <select class="code-setup__select"
                t-model="state.selectedServerId"
                t-on-change="onServerChange">
          <option value="">-- Choisir un serveur --</option>
          <t t-foreach="state.servers" t-as="srv" t-key="srv.host + '|' + srv.username">
            <option t-att-value="srv.host + '|' + srv.username"
                    t-esc="(srv.label || srv.host) + ' (' + srv.username + '@' + srv.host + ')'" />
          </t>
        </select>

        <t t-if="state.selectedServerId">
          <div class="code-setup__label">Workspace</div>
          <t t-if="state.workspacesLoading">
            <div class="code__spinner">Chargement des workspaces…</div>
          </t>
          <t t-elif="state.serverWorkspaces.length > 0">
            <ul class="code-setup__workspace-list">
              <t t-foreach="state.serverWorkspaces" t-as="ws" t-key="ws.path">
                <li class="code-setup__workspace-item"
                    t-att-class="{ 'code-setup__workspace-item--active': state.repoPath === ws.path }"
                    t-on-click="() => state.repoPath = ws.path">
                  <span class="code-setup__workspace-icon">🗂</span>
                  <span class="code-setup__workspace-path" t-esc="ws.path" />
                </li>
              </t>
            </ul>
          </t>
          <t t-else="">
            <div class="code__empty">Aucun workspace configuré pour ce serveur.</div>
          </t>

          <div class="code-setup__label">Chemin personnalisé</div>
          <input class="code-setup__input" type="text"
                 t-model="state.repoPath"
                 placeholder="ex: ~/git/erplibre_mobile2/mobile/erplibre_home_mobile"
                 autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" />
        </t>
      </t>

      <!-- ── SSH URL (offline manifest repos) ── -->
      <t t-if="state.mode === 'ssh-url'">
        <t t-if="state.manifestProjects.length > 0">
          <div class="code-setup__label">Dépôts disponibles</div>
          <div class="code-setup__chips">
            <t t-foreach="state.manifestProjects" t-as="proj" t-key="proj.slug">
              <button class="code-setup__chip"
                      t-att-class="{ 'code-setup__chip--active': state.repoPath === proj.url }"
                      t-on-click="() => state.repoPath = proj.url">
                <span class="code-setup__chip-name" t-esc="proj.name" />
                <span class="code-setup__chip-rev" t-esc="'@' + proj.revision" />
              </button>
            </t>
          </div>
        </t>
        <t t-else="">
          <div class="code__empty">Aucun dépôt disponible dans le bundle. Recompilez l'application.</div>
        </t>

        <div class="code-setup__label">URL Git</div>
        <input class="code-setup__input" type="text"
               t-model="state.repoPath"
               placeholder="https://github.com/user/repo.git"
               autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" />
      </t>

      <!-- Error -->
      <t t-if="state.error">
        <div class="code__error" t-esc="state.error" />
      </t>

      <button class="code__btn code__btn--primary"
              t-att-disabled="state.loading or this.connectDisabled"
              t-on-click="() => this.onConnect()">
        <t t-if="state.loading">Connexion…</t>
        <t t-else="">Connecter</t>
      </button>

    </div>
  </t>

  <!-- ══════════════════ BROWSER ══════════════════ -->
  <t t-if="state.phase === 'browser'">

    <div class="code-browser__header">
      <div class="code-browser__server-info">
        <span class="code-browser__server-label" t-esc="state.serverLabel" />
        <span class="code-browser__branch" t-esc="state.currentBranch" />
      </div>
      <t t-if="state.mode === 'ssh-url' and !state.isEditable">
        <button class="code__btn code__btn--edit"
                t-on-click="() => this.onPromoteEdit()"
                t-att-disabled="state.promoting">
          <t t-if="state.promoting">⏳ Promotion…</t>
          <t t-else="">✏️ Activer édition</t>
        </button>
      </t>
      <t t-if="state.mode === 'ssh-url' and state.isEditable">
        <button class="code__btn code__btn--unpromote"
                t-on-click="() => this.onUnpromote()">
          🔒 Sortir édition
        </button>
      </t>
      <button class="code__btn code__btn--disconnect" t-on-click="() => this.onDisconnect()">
        ✕ Déconnecter
      </button>
    </div>

    <t t-if="state.baselineMismatch">
      <div class="code__warning code__warning--baseline">
        <strong>⚠ Baseline modifié</strong> —
        l'application a été recompilée depuis que tu as activé l'édition de ce repo.
        Ton historique git est basé sur l'ancien baseline (<em t-esc="state.promotedBuildId" />),
        le nouveau est <em t-esc="state.shippedBuildId" />.
        <button class="code__btn code__btn--baseline-update"
                t-on-click="() => this.onRepromoteBaseline()">
          🔄 Réinitialiser au nouveau baseline (perd les modifications)
        </button>
      </div>
    </t>

    <div class="code-browser__tabs">
      <button class="code-browser__tab"
              t-att-class="{ 'code-browser__tab--active': state.tab === 'files' }"
              t-on-click="() => this.onTabFiles()">📂 Fichiers</button>
      <button class="code-browser__tab"
              t-if="state.mode === 'ssh-path'"
              t-att-class="{ 'code-browser__tab--active': state.tab === 'git' }"
              t-on-click="() => this.onTabGit()">🔀 Git</button>
    </div>

    <t t-if="state.error">
      <div class="code__error" t-esc="state.error" />
    </t>

    <!-- ── Files tab ──────────────────────────────── -->
    <t t-if="state.tab === 'files'">

      <!-- ── File viewer ── -->
      <t t-if="state.currentFilePath">

        <div class="code-viewer__header">
          <button class="code__btn code__btn--back" t-on-click="() => this.onCloseFile()">← Retour</button>
          <span class="code-viewer__filename" t-esc="state.currentFileName" />
          <!-- language badge -->
          <t t-if="state.fileLang and state.fileLang !== 'image' and state.fileLang !== 'markdown' and state.fileLang !== ''">
            <span class="code-viewer__lang-badge" t-esc="state.fileLang" />
          </t>
          <!-- Markdown toggle -->
          <t t-if="state.fileLang === 'markdown'">
            <button class="code__btn code__btn--mode" t-on-click="() => this.onToggleViewMode()">
              <t t-if="state.fileViewMode === 'markdown'">⌨ Code</t>
              <t t-else="">👁 Aperçu</t>
            </button>
          </t>
          <!-- Image toggle -->
          <t t-if="state.fileLang === 'image'">
            <button class="code__btn code__btn--mode" t-on-click="() => this.onToggleViewMode()">
              <t t-if="state.fileViewMode === 'image'">⌨ Brut</t>
              <t t-else="">🖼 Image</t>
            </button>
          </t>
        </div>

        <t t-if="state.fileLoading">
          <div class="code__spinner">Chargement…</div>
        </t>

        <!-- Image view -->
        <t t-elif="state.fileViewMode === 'image'">
          <div class="code-viewer__image-wrap">
            <t t-if="state.fileImageSrc">
              <img t-att-src="state.fileImageSrc" class="code-viewer__image" alt="" />
            </t>
            <t t-else="">
              <div class="code__spinner">Chargement de l'image…</div>
            </t>
          </div>
        </t>

        <!-- Markdown preview -->
        <t t-elif="state.fileViewMode === 'markdown'">
          <div class="code-viewer__markdown" t-out="state.fileMarkdownHtml" />
        </t>

        <!-- Code view (plain or highlighted) -->
        <t t-else="">
          <div class="code-viewer__code">
            <t t-if="state.fileLines.length === 0">
              <div class="code__empty">Fichier vide.</div>
            </t>
            <t t-foreach="state.fileLines" t-as="line" t-key="line_index">

              <!-- Editing line -->
              <t t-if="state.editingLineIndex === line_index">
                <div class="code-line code-line--editing">
                  <span class="code-line__num" t-esc="line_index + 1" />
                  <input class="code-line__input"
                         t-att-id="'code-line-input-' + line_index"
                         t-model="state.editLineValue"
                         autocomplete="off" autocapitalize="none"
                         autocorrect="off" spellcheck="false"
                         t-on-keydown="(e) => this.onEditKeyDown(e, line_index)" />
                  <div class="code-line__edit-btns">
                    <button class="code__btn code__btn--save"
                            t-att-disabled="state.editSaving"
                            t-on-click="() => this.onSaveLine(line_index)">
                      <t t-if="state.editSaving">…</t><t t-else="">✓</t>
                    </button>
                    <button class="code__btn code__btn--cancel"
                            t-att-disabled="state.editSaving"
                            t-on-click="() => this.onCancelEdit()">✗</button>
                  </div>
                </div>
              </t>

              <!-- Normal line (highlighted or plain) -->
              <t t-else="">
                <div class="code-line">
                  <span class="code-line__num" t-esc="line_index + 1" />
                  <!-- highlighted HTML -->
                  <span t-if="state.fileHighlightedLines.length > 0"
                        class="code-line__content"
                        t-att-class="{ 'code-line__content--editable': state.mode === 'ssh-path' }"
                        t-out="state.fileHighlightedLines[line_index]"
                        t-on-click="() => state.mode === 'ssh-path' and this.onEditLine(line_index, line)" />
                  <!-- plain text -->
                  <span t-else=""
                        class="code-line__content"
                        t-att-class="{ 'code-line__content--editable': state.mode === 'ssh-path' }"
                        t-esc="line"
                        t-on-click="() => state.mode === 'ssh-path' and this.onEditLine(line_index, line)" />
                  <button class="code-line__add-note"
                          title="Créer une note depuis cette ligne"
                          t-on-click.stop="() => this.onAddNoteFromLine(line_index, line)">+</button>
                </div>
              </t>

            </t>
          </div>
        </t>

      </t>

      <!-- ── File tree ── -->
      <t t-else="">

        <div class="code-tree__path-bar">
          <span class="code-tree__path-text" t-esc="state.currentDirPath || '(racine)'" />
          <button class="code__btn code__btn--up"
                  t-if="this.canGoUp"
                  t-on-click="() => this.onDirUp()">↑</button>
        </div>

        <t t-if="state.dirLoading">
          <div class="code__spinner">Chargement…</div>
        </t>
        <t t-else="">
          <ul class="code-tree__list">
            <t t-foreach="state.dirEntries" t-as="entry" t-key="entry.path">
              <li class="code-tree__item"
                  t-att-class="{ 'code-tree__item--dir': entry.type === 'dir', 'code-tree__item--file': entry.type === 'file' }"
                  t-on-click="() => this.onEntryClick(entry)">
                <span class="code-tree__icon">
                  <t t-if="entry.type === 'dir'">📁</t>
                  <t t-else="">📄</t>
                </span>
                <span class="code-tree__name" t-esc="entry.name" />
              </li>
            </t>
            <li class="code-tree__empty" t-if="state.dirEntries.length === 0">Répertoire vide.</li>
          </ul>
        </t>

      </t>

    </t>

    <!-- ── Git tab (ssh-path only) ─────────────────── -->
    <t t-if="state.tab === 'git' and state.mode === 'ssh-path'">
      <div class="code-git">

        <div class="code-git__section">
          <div class="code-git__section-header">
            <span>Statut — <em t-esc="state.currentBranch" /></span>
            <div class="code-git__header-btns">
              <button class="code__btn code__btn--refresh"
                      t-att-disabled="state.gitLoading"
                      t-on-click="() => this.onGitRefresh()">↻ Rafraîchir</button>
            </div>
          </div>
          <t t-if="state.gitLoading and !state.gitStatus">
            <div class="code__spinner">Chargement…</div>
          </t>
          <t t-elif="state.gitStatus">
            <pre class="code-git__status" t-esc="state.gitStatus" />
          </t>
          <t t-else="">
            <div class="code-git__clean">Aucun changement.</div>
          </t>
        </div>

        <div class="code-git__section">
          <div class="code-git__section-header">Branches</div>
          <ul class="code-git__branches">
            <t t-foreach="state.gitBranches" t-as="branch" t-key="branch.name">
              <li class="code-git__branch" t-att-class="{ 'code-git__branch--current': branch.current }">
                <span class="code-git__branch-name"
                      t-esc="branch.current ? '→ ' + branch.name : branch.name" />
                <button class="code__btn code__btn--checkout"
                        t-if="!branch.current"
                        t-att-disabled="state.gitLoading"
                        t-on-click="() => this.onGitCheckout(branch.name)">Checkout</button>
              </li>
            </t>
          </ul>
        </div>

        <div class="code-git__section">
          <div class="code-git__section-header">Commit (git add -A)</div>
          <textarea class="code-git__msg-input"
                    placeholder="Message de commit…"
                    t-model="state.gitCommitMessage"
                    rows="3" />
          <button class="code__btn code__btn--primary"
                  t-att-disabled="state.gitLoading or !state.gitCommitMessage.trim()"
                  t-on-click="() => this.onGitCommit()">
            <t t-if="state.gitLoading">En cours…</t><t t-else="">📦 Committer</t>
          </button>
        </div>

        <t t-if="state.gitOutput">
          <div class="code-git__section">
            <div class="code-git__section-header">Sortie</div>
            <pre class="code-git__output" t-esc="state.gitOutput" />
          </div>
        </t>

        <div class="code-git__section">
          <div class="code-git__section-header">Historique</div>
          <ul class="code-git__log">
            <t t-foreach="state.gitLog" t-as="commit" t-key="commit.hash">
              <li class="code-git__commit">
                <div class="code-git__commit-top">
                  <span class="code-git__commit-hash" t-esc="commit.shortHash" />
                  <span class="code-git__commit-subject" t-esc="commit.subject" />
                </div>
                <div class="code-git__commit-meta">
                  <t t-esc="commit.author" /> · <t t-esc="commit.date" />
                </div>
                <button class="code__btn code__btn--checkout code__btn--sm"
                        t-att-disabled="state.gitLoading"
                        t-on-click="() => this.onGitCheckout(commit.hash)">Checkout</button>
              </li>
            </t>
            <li class="code-git__empty"
                t-if="state.gitLog.length === 0 and !state.gitLoading">Aucun commit.</li>
          </ul>
        </div>

      </div>
    </t>

  </t>
</div>
    `;

    static components = { HeadingComponent };

    private _codeService: CodeService | null = null;
    private _bundleService: BundleCodeService | null = null;
    private _repoFs: RepoFs | null = null;

    // ── Reader interface ──────────────────────────────────────────────────────

    private get _reader(): {
        listDir(p: string): Promise<DirEntry[]>;
        readFile(p: string): Promise<string>;
    } {
        if (this.state.mode === "ssh-path") return this._codeService!;
        if (this._repoFs) return this._repoFs;
        return this._bundleService!;
    }

    get canGoUp(): boolean {
        if (this.state.mode !== "ssh-path") return this.state.currentDirPath !== "";
        return this.state.currentDirPath !== this.state.repoPath;
    }

    get connectDisabled(): boolean {
        if (this.state.mode === "bundle") return false;
        if (this.state.mode === "ssh-url") return !this.state.repoPath.trim();
        return !this.state.selectedServerId || !this.state.repoPath.trim();
    }

    // ── Setup ─────────────────────────────────────────────────────────────────

    async setup() {
        this.state = useState({
            phase: "setup" as Phase,
            mode: "bundle" as Mode,

            servers: [] as Server[],
            selectedServerId: "",
            repoPath: "",
            error: "",
            loading: false,

            serverWorkspaces: [] as Workspace[],
            workspacesLoading: false,
            manifestProjects: [] as ManifestProject[],

            tab: "files" as BrowserTab,
            serverLabel: "",
            currentBranch: "",

            currentDirPath: "",
            dirEntries: [] as DirEntry[],
            dirLoading: false,

            currentFilePath: "",
            currentFileName: "",
            fileLang: "" as FileLang,
            fileLines: [] as string[],
            fileHighlightedLines: [] as string[],
            fileViewMode: "code" as FileViewMode,
            fileMarkdownHtml: "",
            fileImageSrc: "",
            fileLoading: false,

            editingLineIndex: -1,
            editLineValue: "",
            editSaving: false,

            gitStatus: "",
            gitLog: [] as GitCommit[],
            gitBranches: [] as GitBranch[],
            gitCommitMessage: "",
            gitLoading: false,
            gitOutput: "",

            // Edit-mode (manifest repo promoted to Documents + git baseline)
            currentSlug: "",
            currentArchiveUrl: "",
            isEditable: false,
            promoting: false,
            baselineMismatch: false,
            shippedBuildId: "",
            promotedBuildId: "",
            // Editable git UI state
            editGitStatus: { modified: [] as string[], untracked: [] as string[],
                             staged: [] as string[], deleted: [] as string[] },
            editGitDiff: "",
            editGitDiffFile: "",
            editGitCommitMessage: "",
            editGitLog: [] as GitCommit[],
        });

        onWillDestroy(async () => { await this._codeService?.disconnect(); });

        this.state.servers = await this.serverService.getServers();

        try {
            const res = await fetch("/repos/manifest.json");
            if (res.ok) this.state.manifestProjects = await res.json();
        } catch { /* dev server: no manifest */ }
    }

    // ── Mode / server ─────────────────────────────────────────────────────────

    onModeChange(mode: Mode): void {
        this.state.mode = mode;
        this.state.error = "";
        this.state.repoPath = "";
        this.state.serverWorkspaces = [];
    }

    async onServerChange(): Promise<void> {
        this.state.repoPath = "";
        this.state.serverWorkspaces = [];
        if (!this.state.selectedServerId) return;
        const [host, username] = this.state.selectedServerId.split("|");
        this.state.workspacesLoading = true;
        try {
            this.state.serverWorkspaces = await this.serverService.getWorkspaces({ host, username });
        } catch {
            this.state.serverWorkspaces = [];
        } finally {
            this.state.workspacesLoading = false;
        }
    }

    // ── Connect ───────────────────────────────────────────────────────────────

    async onConnect(): Promise<void> {
        this.state.error = "";
        this.state.loading = true;
        try {
            if (this.state.mode === "bundle")   await this._connectBundle();
            else if (this.state.mode === "ssh-url") await this._connectSshUrl();
            else                                await this._connectSshPath();
        } catch (err: unknown) {
            this.state.error = err instanceof Error ? err.message : "Connexion échouée.";
            await this._codeService?.disconnect();
            this._codeService = null;
        } finally {
            this.state.loading = false;
        }
    }

    private async _connectBundle(): Promise<void> {
        this._bundleService = new BundleCodeService("/repo");
        await this._bundleService.initialize();
        this.state.serverLabel = "Bundle (sources embarquées)";
        this.state.currentBranch = "(lecture seule)";
        await this._loadDir("");
        this.state.phase = "browser";
    }

    private async _connectSshUrl(): Promise<void> {
        const url = this.state.repoPath.trim();
        const project = this.state.manifestProjects.find((p) => p.url === url);
        if (!project) {
            throw new Error(
                "URL non trouvée dans le bundle. Recompilez l'application ou choisissez un dépôt de la liste.",
            );
        }
        this._repoFs = await getRepoFs(
            project,
            this.env.repoExtractorService,
            this.env.repoEditService,
        );
        this.state.currentSlug = project.slug;
        this.state.currentArchiveUrl = `/${project.archive}`;
        this.state.isEditable = await this.env.repoEditService.isEditable(project.slug);
        await this._refreshBaselineStatus();
        this.state.serverLabel = project.name;
        this.state.currentBranch = this.state.isEditable
            ? `${project.revision} (édition)` : `${project.revision} (lecture seule)`;
        await this._loadDir("");
        this.state.phase = "browser";
    }

    // ── Edit-mode promotion ────────────────────────────────────────────────────

    async onPromoteEdit(): Promise<void> {
        if (this.state.promoting || this.state.isEditable) return;
        if (!this.state.currentSlug || !this.state.currentArchiveUrl) {
            this.state.error = "Cannot promote: no current repo.";
            return;
        }
        this.state.promoting = true;
        this.state.error = "";
        try {
            await this.env.repoEditService.promoteToEditable(
                this.state.currentSlug,
                this.state.currentArchiveUrl,
            );
            // Switch _repoFs to EditableCodeService for this slug.
            const project = this.state.manifestProjects.find(
                (p) => p.slug === this.state.currentSlug,
            );
            if (project) {
                this._repoFs = await getRepoFs(
                    project,
                    this.env.repoExtractorService,
                    this.env.repoEditService,
                );
            }
            this.state.isEditable = true;
            await this._refreshBaselineStatus();
            this.state.currentBranch = this.state.currentBranch.replace(
                "(lecture seule)", "(édition)",
            );
            await this._loadDir(this.state.currentDirPath);
        } catch (e) {
            this.state.error = `Promotion échouée: ${e instanceof Error ? e.message : String(e)}`;
        } finally {
            this.state.promoting = false;
        }
    }

    /**
     * After loading or promotion, compare the stored editable baseline build_id
     * to the currently-shipped build_id. Sets state.baselineMismatch when the
     * developer has rebuilt the app since the user promoted this repo.
     */
    private async _refreshBaselineStatus(): Promise<void> {
        if (!this.state.isEditable || !this.state.currentSlug) {
            this.state.baselineMismatch = false;
            this.state.shippedBuildId = "";
            this.state.promotedBuildId = "";
            return;
        }
        try {
            const meta = await this.env.repoEditService.getEditableMeta(this.state.currentSlug);
            const shipped = await this.env.repoEditService.getShippedBuildId();
            this.state.promotedBuildId = meta?.build_id ?? "";
            this.state.shippedBuildId = shipped;
            this.state.baselineMismatch =
                !!meta && shipped !== "unknown" && meta.build_id !== shipped;
        } catch (e) {
            console.warn("[code] baseline status check failed:", e);
            this.state.baselineMismatch = false;
        }
    }

    /** User chose "re-promote" after baseline drift — drops edits + re-promotes. */
    async onRepromoteBaseline(): Promise<void> {
        const ok = window.confirm(
            "Réinitialiser ce repo au nouveau baseline? Toutes les modifications seront perdues. " +
            "Conseille de commiter d'abord si tu veux garder un historique.",
        );
        if (!ok) return;
        await this.onUnpromote();
        await this.onPromoteEdit();
    }

    async onUnpromote(): Promise<void> {
        if (!this.state.isEditable || !this.state.currentSlug) return;
        const ok = window.confirm(
            "Annuler le mode édition? Toutes les modifications non commitées seront perdues.",
        );
        if (!ok) return;
        try {
            await this.env.repoEditService.unpromote(this.state.currentSlug);
            this.state.isEditable = false;
            this.state.currentBranch = this.state.currentBranch.replace(
                "(édition)", "(lecture seule)",
            );
            const project = this.state.manifestProjects.find(
                (p) => p.slug === this.state.currentSlug,
            );
            if (project) {
                this._repoFs = await getRepoFs(
                    project,
                    this.env.repoExtractorService,
                    this.env.repoEditService,
                );
            }
            await this._loadDir(this.state.currentDirPath);
        } catch (e) {
            this.state.error = `Unpromote échoué: ${e instanceof Error ? e.message : String(e)}`;
        }
    }

    private async _connectSshPath(): Promise<void> {
        const [host, username] = this.state.selectedServerId.split("|");
        const server = await this.serverService.getMatch({ host, username });
        const label = server.label || server.host;
        this.state.serverLabel = `${label} (${server.username}@${server.host})`;

        this._codeService = new CodeService();
        await this._codeService.connect(server);

        let repoPath = this.state.repoPath.trim();
        if (repoPath.startsWith("~/")) {
            const { lines } = await (this._codeService as any).collect("echo $HOME");
            const home = lines[0]?.trim() ?? "";
            if (home) repoPath = home + repoPath.slice(1);
        }
        this.state.repoPath = repoPath;
        this.state.currentBranch = await this._codeService.gitCurrentBranch(repoPath);
        await this._loadDir(repoPath);
        this.state.phase = "browser";
    }

    async onDisconnect(): Promise<void> {
        await this._codeService?.disconnect();
        this._codeService = null;
        this._bundleService = null;
        this._repoFs = null;
        this.state.currentSlug = "";
        this.state.currentArchiveUrl = "";
        this.state.isEditable = false;
        this.state.baselineMismatch = false;
        this.state.phase = "setup";
        this.state.error = "";
        this.state.currentFilePath = "";
        this.state.fileLines = [];
        this.state.fileHighlightedLines = [];
        this.state.gitOutput = "";
    }

    // ── File tree ─────────────────────────────────────────────────────────────

    private async _loadDir(dirPath: string): Promise<void> {
        if (!this._reader) return;
        this.state.dirLoading = true;
        this.state.dirEntries = [];
        this.state.error = "";
        try {
            this.state.dirEntries = await this._reader.listDir(dirPath);
            this.state.currentDirPath = dirPath;
        } catch (err: unknown) {
            this.state.error = err instanceof Error ? err.message : "Erreur lecture répertoire.";
        } finally {
            this.state.dirLoading = false;
        }
    }

    async onEntryClick(entry: DirEntry): Promise<void> {
        if (entry.type === "dir") await this._loadDir(entry.path);
        else await this._loadFile(entry.path, entry.name);
    }

    async onDirUp(): Promise<void> {
        let parent: string;
        if (this.state.mode !== "ssh-path") {
            parent = this.state.currentDirPath.includes("/")
                ? this.state.currentDirPath.slice(0, this.state.currentDirPath.lastIndexOf("/"))
                : "";
        } else {
            parent = this.state.currentDirPath.replace(/\/[^/]+\/?$/, "") || "/";
        }
        await this._loadDir(parent);
    }

    onTabFiles(): void { this.state.tab = "files"; this.state.error = ""; }

    async onTabGit(): Promise<void> {
        this.state.tab = "git";
        this.state.error = "";
        await this.onGitRefresh();
    }

    // ── File viewer ───────────────────────────────────────────────────────────

    private async _loadFile(filePath: string, fileName: string): Promise<void> {
        this.state.fileLoading = true;
        this.state.currentFilePath = filePath;
        this.state.currentFileName = fileName;
        this.state.fileLines = [];
        this.state.fileHighlightedLines = [];
        this.state.fileImageSrc = "";
        this.state.fileMarkdownHtml = "";
        this.state.editingLineIndex = -1;
        this.state.error = "";

        const lang = detectFileLang(fileName);
        this.state.fileLang = lang;

        // Set default view mode
        if (lang === "markdown")   this.state.fileViewMode = "markdown";
        else if (lang === "image") this.state.fileViewMode = "image";
        else                       this.state.fileViewMode = "code";

        try {
            if (lang === "image") {
                // Resolve image source
                if (this.state.mode === "ssh-path" && this._codeService) {
                    const b64 = await this._codeService.readFileAsBase64(filePath);
                    const mime = imageMime(fileName);
                    this.state.fileImageSrc = `data:${mime};base64,${b64}`;
                } else if (this._bundleService) {
                    this.state.fileImageSrc = this._bundleService.getFileUrl(filePath);
                }
            } else {
                // Text file
                const content = await this._reader.readFile(filePath);
                const lines = content.split("\n");
                if (lines[lines.length - 1] === "") lines.pop();
                this.state.fileLines = lines;

                if (lang === "markdown") {
                    this.state.fileMarkdownHtml = renderMarkdown(content);
                } else if (supportsHighlight(lang)) {
                    this.state.fileHighlightedLines = lines.map((l) => highlightLine(l, lang));
                }
            }
        } catch (err: unknown) {
            this.state.error = err instanceof Error ? err.message : "Erreur lecture fichier.";
        } finally {
            this.state.fileLoading = false;
        }
    }

    onCloseFile(): void {
        this.state.currentFilePath = "";
        this.state.currentFileName = "";
        this.state.fileLines = [];
        this.state.fileHighlightedLines = [];
        this.state.editingLineIndex = -1;
        this.state.error = "";
    }

    onToggleViewMode(): void {
        if (this.state.fileLang === "markdown") {
            this.state.fileViewMode = this.state.fileViewMode === "markdown" ? "code" : "markdown";
            if (this.state.fileViewMode === "markdown" && !this.state.fileMarkdownHtml) {
                this.state.fileMarkdownHtml = renderMarkdown(this.state.fileLines.join("\n"));
            }
        } else if (this.state.fileLang === "image") {
            this.state.fileViewMode = this.state.fileViewMode === "image" ? "code" : "image";
        }
    }

    // ── Line editing (ssh-path only) ──────────────────────────────────────────

    onEditLine(lineIndex: number, content: string): void {
        if (this.state.mode !== "ssh-path") return;
        if (this.state.editingLineIndex === lineIndex) return;
        this.state.editingLineIndex = lineIndex;
        this.state.editLineValue = content;
        setTimeout(() => {
            const el = document.getElementById(`code-line-input-${lineIndex}`);
            el?.focus();
            if (el instanceof HTMLInputElement) el.setSelectionRange(content.length, content.length);
        }, 40);
    }

    onEditKeyDown(e: KeyboardEvent, lineIndex: number): void {
        if (e.key === "Enter") this.onSaveLine(lineIndex);
        if (e.key === "Escape") this.onCancelEdit();
    }

    async onSaveLine(lineIndex: number): Promise<void> {
        if (!this._codeService || this.state.editSaving) return;
        this.state.editSaving = true;
        this.state.error = "";
        try {
            await this._codeService.writeLine(
                this.state.currentFilePath,
                lineIndex + 1,
                this.state.editLineValue,
            );
            this.state.fileLines[lineIndex] = this.state.editLineValue;
            // Refresh highlight for the edited line
            if (this.state.fileHighlightedLines.length > 0) {
                this.state.fileHighlightedLines[lineIndex] = highlightLine(
                    this.state.editLineValue, this.state.fileLang,
                );
            }
            this.state.editingLineIndex = -1;
            this.state.fileMarkdownHtml = "";
        } catch (err: unknown) {
            this.state.error = err instanceof Error ? err.message : "Erreur sauvegarde.";
        } finally {
            this.state.editSaving = false;
        }
    }

    onCancelEdit(): void {
        this.state.editingLineIndex = -1;
        this.state.editLineValue = "";
    }

    // ── Note from line ────────────────────────────────────────────────────────

    async onAddNoteFromLine(lineIndex: number, lineContent: string): Promise<void> {
        const fileName = this.state.currentFileName;
        const lineNum = lineIndex + 1;
        const note: Note = {
            id: crypto.randomUUID(),
            title: `${fileName}:${lineNum}`,
            done: false,
            archived: false,
            pinned: false,
            tags: ["code"],
            entries: [{
                id: crypto.randomUUID(),
                type: "text",
                params: {
                    text: lineContent.trim() || `${fileName}:${lineNum}`,
                    readonly: false,
                },
            }],
        };
        await this.noteService.crud.add(note);
        this.navigate(`/note/${note.id}`);
    }

    // ── Git (ssh-path only) ───────────────────────────────────────────────────

    async onGitRefresh(): Promise<void> {
        if (!this._codeService) return;
        this.state.gitLoading = true;
        this.state.error = "";
        try {
            const repo = this.state.repoPath;
            const [status, log, branches, branch] = await Promise.all([
                this._codeService.gitStatus(repo),
                this._codeService.gitLog(repo),
                this._codeService.gitBranches(repo),
                this._codeService.gitCurrentBranch(repo),
            ]);
            this.state.gitStatus = status;
            this.state.gitLog = log;
            this.state.gitBranches = branches;
            this.state.currentBranch = branch;
        } catch (err: unknown) {
            this.state.error = err instanceof Error ? err.message : "Erreur git.";
        } finally {
            this.state.gitLoading = false;
        }
    }

    async onGitCheckout(ref: string): Promise<void> {
        if (!this._codeService) return;
        this.state.gitLoading = true;
        this.state.gitOutput = "";
        this.state.error = "";
        try {
            const { output, exitCode } = await this._codeService.gitCheckout(this.state.repoPath, ref);
            this.state.gitOutput = output;
            if (exitCode === 0) {
                this.state.currentBranch = await this._codeService.gitCurrentBranch(this.state.repoPath);
                await this.onGitRefresh();
                if (this.state.currentFilePath) {
                    await this._loadFile(this.state.currentFilePath, this.state.currentFileName);
                }
            } else {
                this.state.error = `Checkout échoué (code ${exitCode}).`;
            }
        } catch (err: unknown) {
            this.state.error = err instanceof Error ? err.message : "Erreur checkout.";
        } finally {
            this.state.gitLoading = false;
        }
    }

    async onGitCommit(): Promise<void> {
        if (!this._codeService || !this.state.gitCommitMessage.trim()) return;
        this.state.gitLoading = true;
        this.state.gitOutput = "";
        this.state.error = "";
        try {
            const { output, exitCode } = await this._codeService.gitCommit(
                this.state.repoPath, this.state.gitCommitMessage.trim(),
            );
            this.state.gitOutput = output;
            if (exitCode === 0) {
                this.state.gitCommitMessage = "";
                await this.onGitRefresh();
            } else {
                this.state.error = `Commit échoué (code ${exitCode}).`;
            }
        } catch (err: unknown) {
            this.state.error = err instanceof Error ? err.message : "Erreur commit.";
        } finally {
            this.state.gitLoading = false;
        }
    }
}
