import { useState, onPatched, onWillDestroy, xml } from "@odoo/owl";
import type { PluginListenerHandle } from "@capacitor/core";

import { Server } from "../../../models/server";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { HeadingComponent } from "../../heading/heading_component";
import { SshPlugin } from "../../../plugins/sshPlugin";

type Phase = "loading" | "info" | "connecting" | "terminal" | "cd-picker";

interface TerminalEntry {
    type: "command" | "stdout" | "stderr" | "info" | "error";
    text: string;
}

export class ServersWorkspaceComponent extends EnhancedComponent {
    static template = xml`
      <div id="servers-workspace-component">
        <HeadingComponent title="'Workspace'" breadcrumbs="breadcrumbs" />

        <!-- ── Loading / Connecting ──────────────────────────────── -->
        <t t-if="state.phase === 'loading' or state.phase === 'connecting'">
          <div class="workspace__loading">
            <span class="workspace__spinner">◌</span>
            <t t-if="state.phase === 'loading'">Connexion en cours…</t>
            <t t-if="state.phase === 'connecting'">Ouverture du terminal…</t>
          </div>
        </t>

        <!-- ── Info ─────────────────────────────────────────────── -->
        <t t-if="state.phase === 'info'">
          <div class="workspace__info">

            <div class="workspace__info-server" t-if="state.server">
              <span class="workspace__server-label"
                    t-esc="state.server.label || state.server.host" />
              <span class="workspace__server-address">
                <t t-esc="state.server.username" />@<t t-esc="state.server.host" />
              </span>
            </div>

            <div class="workspace__info-field">
              <span class="workspace__info-label">Chemin</span>
              <span class="workspace__info-value workspace__info-value--mono"
                    t-esc="state.workspacePath" />
            </div>

            <t t-if="state.infoError">
              <div class="workspace__info-error" t-esc="state.infoError" />
            </t>

            <t t-if="!state.infoError">
              <div class="workspace__info-field" t-if="state.semverVersion">
                <span class="workspace__info-label">.erplibre-semver-version</span>
                <span class="workspace__info-value workspace__info-value--version"
                      t-esc="state.semverVersion" />
              </div>

              <div class="workspace__info-field" t-if="state.erplibreVersion">
                <span class="workspace__info-label">.erplibre-version</span>
                <span class="workspace__info-value workspace__info-value--version"
                      t-esc="state.erplibreVersion" />
              </div>

              <div class="workspace__info-empty"
                   t-if="!state.semverVersion and !state.erplibreVersion">
                Fichiers de version introuvables.
              </div>
            </t>

            <div class="workspace__info-actions">
              <button class="workspace__btn-terminal"
                      t-on-click="() => this.onOpenTerminal()">
                Terminal
              </button>
              <button class="workspace__btn-back"
                      t-on-click="() => window.history.back()">
                Retour
              </button>
            </div>

          </div>
        </t>

        <!-- ── Terminal ─────────────────────────────────────────── -->
        <t t-if="state.phase === 'terminal'">

          <div class="workspace__terminal-header">
            <div class="workspace__terminal-path">
              <span class="workspace__terminal-user"
                    t-if="state.server"
                    t-esc="state.server.username + '@' + state.server.host" />
              <span class="workspace__terminal-cwd"
                    t-esc="':' + state.currentPath" />
            </div>
            <button class="workspace__btn-done"
                    t-att-disabled="state.running"
                    t-on-click="() => this.onCloseTerminal()">
              Terminer
            </button>
          </div>

          <div class="workspace__terminal-toolbar">
            <button class="workspace__terminal-nav-btn"
                    title="Aller au début"
                    t-on-click="() => this.scrollTerminalToTop()">
              ↑ Haut
            </button>
            <span class="workspace__terminal-lock-indicator"
                  t-if="state.autoScroll">⬇ suivi</span>
            <button class="workspace__terminal-nav-btn workspace__terminal-nav-btn--bottom"
                    title="Aller à la fin"
                    t-on-click="() => this.scrollTerminalToBottom()">
              ↓ Bas
            </button>
          </div>

          <div class="workspace__terminal-output"
               id="workspace-terminal-output"
               t-on-scroll="(e) => this.onTerminalScroll(e)">
            <t t-foreach="state.entries" t-as="entry" t-key="entry_index">
              <div t-att-class="'workspace__entry workspace__entry--' + entry.type"
                   t-esc="entry.text" />
            </t>
            <t t-if="state.running">
              <span class="workspace__cursor">▌</span>
            </t>
          </div>

          <div class="workspace__quick-btns">
            <button class="workspace__quick-btn"
                    t-att-disabled="state.running"
                    t-on-click="() => this.onQuickPwd()">
              pwd
            </button>
            <button class="workspace__quick-btn"
                    t-att-disabled="state.running"
                    t-on-click="() => this.onQuickLs()">
              ls
            </button>
            <button class="workspace__quick-btn workspace__quick-btn--cd"
                    t-att-disabled="state.running"
                    t-on-click="() => this.onOpenCdPicker()">
              cd
            </button>
          </div>

          <div class="workspace__terminal-input-row">
            <span class="workspace__terminal-prompt">$</span>
            <input
              type="text"
              id="workspace-terminal-input"
              class="workspace__terminal-input"
              autocomplete="off"
              autocapitalize="none"
              autocorrect="off"
              spellcheck="false"
              t-model="state.commandInput"
              t-att-disabled="state.running"
              t-on-keydown="(e) => this.onInputKeyDown(e)"
            />
            <button class="workspace__btn-send"
                    t-att-disabled="state.running or !state.commandInput.trim()"
                    t-on-click="() => this.onSend()">
              ↩
            </button>
          </div>

        </t>

        <!-- ── CD Picker ─────────────────────────────────────────── -->
        <t t-if="state.phase === 'cd-picker'">

          <div class="workspace__cd-header">
            <span class="workspace__cd-title">Choisir un répertoire</span>
            <button class="workspace__cd-cancel"
                    t-on-click="() => this.onCdCancel()">
              Annuler
            </button>
          </div>

          <div class="workspace__cd-current" t-esc="state.currentPath" />

          <t t-if="state.cdLoading">
            <div class="workspace__cd-loading">
              <span class="workspace__spinner">◌</span> Chargement…
            </div>
          </t>

          <t t-if="!state.cdLoading">
            <t t-if="state.cdError">
              <div class="workspace__cd-error" t-esc="state.cdError" />
            </t>

            <ul class="workspace__cd-list">
              <li class="workspace__cd-item workspace__cd-item--up"
                  t-if="state.currentPath !== '/'"
                  t-on-click="() => this.onCdGoUp()">
                ↑ ..
              </li>

              <t t-foreach="state.cdDirs" t-as="dir" t-key="dir">
                <li class="workspace__cd-item"
                    t-on-click="() => this.onCdSelect(dir)">
                  <span class="workspace__cd-dirname"
                        t-esc="dir.split('/').at(-1) || dir" />
                  <span class="workspace__cd-fullpath" t-esc="dir" />
                </li>
              </t>

              <li class="workspace__cd-empty"
                  t-if="state.cdDirs.length === 0 and !state.cdError">
                Aucun sous-répertoire.
              </li>
            </ul>
          </t>

        </t>

      </div>
    `;

    static components = { HeadingComponent };

    // Non-reactive class properties
    private _sshOpen = false;

    // ── Breadcrumbs ───────────────────────────────────────────────────────────

    get breadcrumbs() {
        const crumbs: { label: string; url: string }[] = [
            { label: "Applications", url: "/applications" },
        ];
        const s = this.state?.server;
        if (s) {
            const h = encodeURIComponent(s.host);
            const u = encodeURIComponent(s.username);
            crumbs.push({
                label: s.label || s.host,
                url: `/servers/settings/${h}/${u}`,
            });
        }
        return crumbs;
    }

    async setup() {
        const params = this.router.getRouteParams(
            window.location.pathname,
            "/servers/workspace/:host/:username"
        );
        const host = decodeURIComponent(params.get("host") ?? "");
        const username = decodeURIComponent(params.get("username") ?? "");
        const urlParams = new URLSearchParams(window.location.search);
        const workspacePath = decodeURIComponent(urlParams.get("path") ?? "");

        this.state = useState({
            phase: "loading" as Phase,
            server: null as Server | null,
            workspacePath,

            // Info
            semverVersion: "",
            erplibreVersion: "",
            infoError: "",

            // Terminal
            currentPath: workspacePath,
            entries: [] as TerminalEntry[],
            commandInput: "",
            running: false,
            autoScroll: true,

            // CD picker
            cdDirs: [] as string[],
            cdLoading: false,
            cdError: "",
        });

        onPatched(() => {
            if (this.state.autoScroll) {
                const el = document.getElementById("workspace-terminal-output");
                if (el) el.scrollTop = el.scrollHeight;
            }
        });

        onWillDestroy(() => {
            if (this._sshOpen) {
                SshPlugin.disconnect().catch(() => {});
                this._sshOpen = false;
            }
        });

        try {
            const server = await this.serverService.getMatch({ host, username });
            this.state.server = server;
            await this.loadInfo(server, workspacePath);
        } catch (error: unknown) {
            this.state.infoError = error instanceof Error ? error.message : "Erreur.";
            this.state.phase = "info";
        }
    }

    // ── SSH helpers ───────────────────────────────────────────────────────────

    private async sshConnect(server: Server): Promise<void> {
        const credential = server.authType === "password"
            ? server.password
            : server.privateKey;
        await SshPlugin.connect({
            host: server.host,
            port: server.port,
            username: server.username,
            authType: server.authType,
            credential,
            passphrase: server.passphrase || undefined,
        });
        this._sshOpen = true;
    }

    private async sshDisconnect(): Promise<void> {
        try { await SshPlugin.disconnect(); } catch (_e) { /* ignore */ }
        this._sshOpen = false;
    }

    /**
     * Run a command, collect all stdout lines, return them with the exit code.
     * Uses its own listener — do NOT call inside another listener scope.
     */
    private async sshCollect(
        command: string
    ): Promise<{ lines: string[]; exitCode: number }> {
        const lines: string[] = [];
        let listener: PluginListenerHandle | null = null;
        try {
            listener = await SshPlugin.addListener("sshOutput", (data) => {
                if (data.stream === "stdout" && data.line.trim()) {
                    lines.push(data.line.trim());
                }
            });
            const result = await SshPlugin.execute({ command });
            return { lines, exitCode: result.exitCode };
        } finally {
            if (listener) await listener.remove();
        }
    }

    private async sshReadFile(path: string): Promise<string> {
        const { lines } = await this.sshCollect(`cat "${path}" 2>/dev/null`);
        return lines.join("\n").trim();
    }

    // ── Info loading ──────────────────────────────────────────────────────────

    private async loadInfo(server: Server, workspacePath: string): Promise<void> {
        try {
            await this.sshConnect(server);
            this.state.semverVersion = await this.sshReadFile(
                `${workspacePath}/.erplibre-semver-version`
            );
            this.state.erplibreVersion = await this.sshReadFile(
                `${workspacePath}/.erplibre-version`
            );
        } catch (error: unknown) {
            this.state.infoError = error instanceof Error
                ? error.message
                : "Connexion SSH échouée.";
        } finally {
            await this.sshDisconnect();
        }
        this.state.phase = "info";
    }

    // ── Terminal ──────────────────────────────────────────────────────────────

    async onOpenTerminal(): Promise<void> {
        const server = this.state.server;
        if (!server) return;

        this.state.phase = "connecting";
        try {
            await this.sshConnect(server);
            this.state.entries = [];
            this.state.currentPath = this.state.workspacePath;
            this.state.commandInput = "";
            this.state.running = false;
            this._autoScroll = true;
            this.state.phase = "terminal";
            setTimeout(() => {
                document.getElementById("workspace-terminal-input")?.focus();
            }, 80);
        } catch (error: unknown) {
            this.state.infoError = error instanceof Error
                ? error.message
                : "Connexion SSH échouée.";
            this.state.phase = "info";
        }
    }

    async onCloseTerminal(): Promise<void> {
        await this.sshDisconnect();
        this.state.phase = "info";
    }

    onInputKeyDown(event: KeyboardEvent): void {
        if (event.key === "Enter") this.onSend();
    }

    async onSend(): Promise<void> {
        const cmd = this.state.commandInput.trim();
        if (!cmd || this.state.running) return;
        this.state.commandInput = "";
        await this.runCommand(cmd);
        setTimeout(() => {
            document.getElementById("workspace-terminal-input")?.focus();
        }, 50);
    }

    private async runCommand(rawCmd: string): Promise<void> {
        if (this.state.running) return;
        this.state.running = true;
        this._autoScroll = true;
        this.state.entries.push({ type: "command", text: `$ ${rawCmd}` });

        const isCd = /^cd(\s|$)/.test(rawCmd);
        const cdLines: string[] = [];
        let listener: PluginListenerHandle | null = null;

        try {
            listener = await SshPlugin.addListener("sshOutput", (data) => {
                if (isCd) {
                    // For cd: capture stdout silently; we'll show the result as info
                    if (data.stream === "stdout") cdLines.push(data.line.trim());
                } else {
                    this.state.entries.push({
                        type: data.stream === "stdout" ? "stdout" : "stderr",
                        text: data.line,
                    });
                }
            });

            let cmdToRun: string;
            if (isCd) {
                const arg = rawCmd.slice(2).trim();
                cmdToRun = arg
                    ? `cd "${this.state.currentPath}" && cd ${arg} && pwd`
                    : `cd && pwd`;
            } else {
                cmdToRun = `cd "${this.state.currentPath}" && ${rawCmd}`;
            }

            const result = await SshPlugin.execute({ command: cmdToRun });

            if (isCd) {
                const newPath = cdLines.filter(Boolean).join("").trim();
                if (result.exitCode === 0 && newPath) {
                    this.state.currentPath = newPath;
                    this.state.entries.push({ type: "info", text: `→ ${newPath}` });
                } else {
                    this.state.entries.push({
                        type: "error",
                        text: "cd: répertoire introuvable.",
                    });
                }
            }

        } catch (error: unknown) {
            this.state.entries.push({
                type: "error",
                text: error instanceof Error ? error.message : "Erreur SSH.",
            });
        } finally {
            if (listener) await listener.remove();
            this.state.running = false;
        }
    }

    // Quick actions ────────────────────────────────────────────────────────────

    onQuickPwd(): void {
        this.state.entries.push({ type: "command", text: "$ pwd" });
        this.state.entries.push({ type: "stdout", text: this.state.currentPath });
    }

    async onQuickLs(): Promise<void> {
        await this.runCommand("ls");
    }

    // ── CD Picker ─────────────────────────────────────────────────────────────

    async onOpenCdPicker(): Promise<void> {
        this.state.phase = "cd-picker";
        this.state.cdLoading = true;
        this.state.cdDirs = [];
        this.state.cdError = "";

        try {
            const { lines, exitCode } = await this.sshCollect(
                `find "${this.state.currentPath}" -maxdepth 1 -mindepth 1 -type d | sort`
            );
            this.state.cdDirs = lines;
            if (exitCode !== 0 && lines.length === 0) {
                this.state.cdError = "Impossible de lister les répertoires.";
            }
        } catch (error: unknown) {
            this.state.cdError = error instanceof Error ? error.message : "Erreur SSH.";
        } finally {
            this.state.cdLoading = false;
        }
    }

    onCdCancel(): void {
        this.state.phase = "terminal";
        setTimeout(() => {
            document.getElementById("workspace-terminal-input")?.focus();
        }, 50);
    }

    onCdSelect(dir: string): void {
        this.state.currentPath = dir;
        this.state.entries.push({ type: "info", text: `→ ${dir}` });
        this.state.phase = "terminal";
        setTimeout(() => {
            document.getElementById("workspace-terminal-input")?.focus();
        }, 50);
    }

    onCdGoUp(): void {
        const parent = this.state.currentPath.replace(/\/[^/]+\/?$/, "") || "/";
        this.state.currentPath = parent;
        this.state.entries.push({ type: "info", text: `→ ${parent}` });
        this.state.phase = "terminal";
        setTimeout(() => {
            document.getElementById("workspace-terminal-input")?.focus();
        }, 50);
    }

    // ── Scroll controls ───────────────────────────────────────────────────────

    scrollTerminalToTop(): void {
        const el = document.getElementById("workspace-terminal-output");
        if (el) {
            el.scrollTop = 0;
            this.state.autoScroll = false;
        }
    }

    scrollTerminalToBottom(): void {
        const el = document.getElementById("workspace-terminal-output");
        if (el) {
            el.scrollTop = el.scrollHeight;
            this.state.autoScroll = true;
        }
    }

    onTerminalScroll(event: Event): void {
        const el = event.target as HTMLElement;
        const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
        this.state.autoScroll = isAtBottom;
    }
}
