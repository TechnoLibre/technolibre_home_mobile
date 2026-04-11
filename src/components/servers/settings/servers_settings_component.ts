import { useState, xml } from "@odoo/owl";
import type { PluginListenerHandle } from "@capacitor/core";

import { Server } from "../../../models/server";
import { Workspace } from "../../../models/workspace";
import type { ActiveDeployment } from "../../../services/deploymentService";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { HeadingComponent } from "../../heading/heading_component";
import { SshPlugin } from "../../../plugins/sshPlugin";
import { Events } from "../../../constants/events";

type DiscoverStatus = "idle" | "connecting" | "running" | "done" | "error";

export class ServersSettingsComponent extends EnhancedComponent {
    static template = xml`
      <div id="servers-settings-component">
        <HeadingComponent title="'Paramètres du serveur'" breadcrumbs="breadcrumbs" />

        <div class="settings__server-info" t-if="state.server">
          <span class="settings__server-label"
                t-esc="state.server.label || state.server.host" />
          <span class="settings__server-address">
            <t t-esc="state.server.username" />@<t t-esc="state.server.host" />:<t t-esc="state.server.port" />
          </span>
        </div>

        <!-- ── Actions ──────────────────────────────────────────── -->
        <div class="settings__actions">
          <button class="settings__btn-new"
                  t-on-click="() => this.onNewClick()">
            Nouveau
          </button>
          <button class="settings__btn-discover"
                  t-att-disabled="state.discoverStatus === 'connecting' or state.discoverStatus === 'running'"
                  t-on-click="() => this.onDiscoverClick()">
            Discover
          </button>
          <button class="settings__btn-resources"
                  t-on-click="() => this.onResourcesClick()">
            Ressources
          </button>
          <button class="settings__btn-back"
                  t-on-click="() => window.history.back()">
            Retour
          </button>
        </div>

        <!-- ── Discover status ───────────────────────────────────── -->
        <div t-att-class="'settings__discover-status settings__discover-status--' + state.discoverStatus"
             t-if="state.discoverMessage">
          <t t-esc="state.discoverMessage" />
        </div>

        <!-- ── Active deployments ────────────────────────────────── -->
        <div class="settings__workspace-section" t-if="this.activeDeployments.length > 0">
          <div class="settings__workspace-title">Déploiements en cours</div>
          <ul class="settings__workspace-list">
            <t t-foreach="this.activeDeployments" t-as="dep" t-key="dep.path">
              <li class="settings__workspace-item settings__deployment-item"
                  t-on-click="() => this.onDeploymentClick(dep)">
                <span class="settings__deployment-status">
                  <t t-if="!dep.done">
                    <span class="settings__deployment-spinner">◌</span>
                  </t>
                  <t t-elif="dep.failedStepIndex !== null">✗</t>
                  <t t-else="">✓</t>
                </span>
                <span class="settings__workspace-path" t-esc="dep.path" />
                <span class="settings__deployment-label"
                      t-esc="!dep.done ? 'En cours…' : dep.failedStepIndex !== null ? 'Échec' : 'Succès'" />
              </li>
            </t>
          </ul>
        </div>

        <!-- ── Workspace list ────────────────────────────────────── -->
        <div class="settings__workspace-section">
          <div class="settings__workspace-title">Workspaces</div>
          <p class="settings__workspace-empty"
             t-if="state.workspaces.length === 0">
            Aucun workspace enregistré.
          </p>
          <ul class="settings__workspace-list" t-if="state.workspaces.length > 0">
            <t t-foreach="state.workspaces" t-as="ws" t-key="ws.path">
              <li class="settings__workspace-item">
                <span class="settings__workspace-path settings__workspace-path--link"
                      t-on-click="() => this.onWorkspaceClick(ws)"
                      t-esc="ws.path" />
                <button class="settings__workspace-btn-deploy"
                        t-on-click="() => this.onDeployWorkspace(ws)">
                  Déployer
                </button>
                <button class="settings__workspace-btn-delete"
                        t-on-click="() => this.onDeleteWorkspace(ws)">
                  ✕
                </button>
              </li>
            </t>
          </ul>
        </div>

      </div>
    `;

    static components = { HeadingComponent };

    async setup() {
        const params = this.router.getRouteParams(
            window.location.pathname,
            "/servers/settings/:host/:username"
        );
        const host = decodeURIComponent(params.get("host") ?? "");
        const username = decodeURIComponent(params.get("username") ?? "");

        this.state = useState({
            server: null as Server | null,
            workspaces: [] as Workspace[],
            discoverStatus: "idle" as DiscoverStatus,
            discoverMessage: "",
        });

        try {
            const server = await this.serverService.getMatch({ host, username });
            this.state.server = server;
            await this.loadWorkspaces(host, username);
        } catch (error: unknown) {
            this.state.discoverStatus = "error";
            this.state.discoverMessage = error instanceof Error
                ? error.message
                : "Serveur introuvable.";
        }
    }

    private async loadWorkspaces(host: string, username: string): Promise<void> {
        const list = await this.serverService.getWorkspaces({ host, username });
        this.state.workspaces = list;
    }

    // ── Breadcrumbs ───────────────────────────────────────────────────────────

    get breadcrumbs() {
        return [{ label: "Applications", url: "/applications" }];
    }

    // ── Active deployments ────────────────────────────────────────────────────

    get activeDeployments(): ActiveDeployment[] {
        const server = this.state.server;
        if (!server) return [];
        return this.deploymentService.getAllForServer(server.host, server.username);
    }

    onDeploymentClick(dep: ActiveDeployment): void {
        const encodedHost = encodeURIComponent(dep.host);
        const encodedUsername = encodeURIComponent(dep.username);
        const encodedPath = encodeURIComponent(
            dep.path.replace(/^\$HOME\//, "~/").replace(/^\$HOME$/, "~")
        );
        this.eventBus.trigger(Events.ROUTER_NAVIGATION, {
            url: `/servers/deploy/${encodedHost}/${encodedUsername}?path=${encodedPath}`,
        });
    }

    // ── Navigation ────────────────────────────────────────────────────────────

    onResourcesClick(): void {
        const server = this.state.server;
        if (!server) return;
        const h = encodeURIComponent(server.host);
        const u = encodeURIComponent(server.username);
        this.eventBus.trigger(Events.ROUTER_NAVIGATION, {
            url: `/servers/resources/${h}/${u}`,
        });
    }

    onNewClick(): void {
        const server = this.state.server;
        if (!server) return;
        const encodedHost = encodeURIComponent(server.host);
        const encodedUsername = encodeURIComponent(server.username);
        this.eventBus.trigger(Events.ROUTER_NAVIGATION, {
            url: `/servers/deploy/${encodedHost}/${encodedUsername}`,
        });
    }

    onWorkspaceClick(ws: Workspace): void {
        const encodedHost = encodeURIComponent(ws.host);
        const encodedUsername = encodeURIComponent(ws.username);
        const encodedPath = encodeURIComponent(ws.path);
        this.eventBus.trigger(Events.ROUTER_NAVIGATION, {
            url: `/servers/workspace/${encodedHost}/${encodedUsername}?path=${encodedPath}`,
        });
    }

    onDeployWorkspace(ws: Workspace): void {
        const encodedHost = encodeURIComponent(ws.host);
        const encodedUsername = encodeURIComponent(ws.username);
        const encodedPath = encodeURIComponent(ws.path);
        this.eventBus.trigger(Events.ROUTER_NAVIGATION, {
            url: `/servers/deploy/${encodedHost}/${encodedUsername}?path=${encodedPath}`,
        });
    }

    async onDeleteWorkspace(ws: Workspace): Promise<void> {
        const confirmed = confirm(`Supprimer le workspace « ${ws.path} » ?`);
        if (!confirmed) return;
        await this.serverService.deleteWorkspace(ws);
        const server = this.state.server;
        if (server) await this.loadWorkspaces(server.host, server.username);
    }

    // ── Discover ──────────────────────────────────────────────────────────────

    async onDiscoverClick(): Promise<void> {
        const server = this.state.server;
        if (!server) return;

        this.state.discoverStatus = "connecting";
        this.state.discoverMessage = "Connexion SSH…";

        try {
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

            this.state.discoverStatus = "running";
            this.state.discoverMessage = "Recherche des workspaces ERPLibre…";

            // Collect stdout lines via the sshOutput listener
            const collectedLines: string[] = [];
            let outputListener: PluginListenerHandle | null = null;
            outputListener = await SshPlugin.addListener("sshOutput", (data) => {
                if (data.stream === "stdout" && data.line.trim().length > 0) {
                    collectedLines.push(data.line.trim());
                }
            });

            // Find dirs whose name contains "erplibre" AND that contain .venv.erplibre
            await SshPlugin.execute({
                command: [
                    "find ~ -maxdepth 4 -type d",
                    "\\( -iname '*erplibre*' \\)",
                    "-exec sh -c",
                    "'[ -d \"$1/.venv.erplibre\" ] && echo \"$1\"'",
                    "_ {} \\;",
                    "2>/dev/null",
                ].join(" "),
            });

            if (outputListener) {
                await outputListener.remove();
                outputListener = null;
            }

            const lines = collectedLines;

            let added = 0;
            for (const line of lines) {
                const ws: Workspace = {
                    host: server.host,
                    username: server.username,
                    path: line,
                };
                const exists = await this.serverService.workspaceExists(ws);
                if (!exists) {
                    await this.serverService.addWorkspace(ws);
                    added++;
                }
            }

            await this.loadWorkspaces(server.host, server.username);
            this.state.discoverStatus = "done";
            this.state.discoverMessage = lines.length === 0
                ? "Aucun workspace trouvé."
                : `${lines.length} workspace(s) trouvé(s), ${added} ajouté(s).`;

        } catch (error: unknown) {
            this.state.discoverStatus = "error";
            this.state.discoverMessage = error instanceof Error
                ? error.message
                : "Erreur lors de la découverte.";
        } finally {
            try { await SshPlugin.disconnect(); } catch (_e) { /* ignore */ }
        }
    }
}
