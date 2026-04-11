import { useState, onPatched, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { HeadingComponent } from "../../heading/heading_component";
import type { ActiveDeployment } from "../../../services/deploymentService";

export class ServersDeployComponent extends EnhancedComponent {
    static template = xml`
      <div id="servers-deploy-component">
        <HeadingComponent title="'Déploiement ERPLibre'" breadcrumbs="breadcrumbs" />

        <!-- ── Wizard ───────────────────────────────────────── -->
        <t t-if="state.phase === 'wizard'">
          <div class="deploy__wizard" t-if="state.server">
            <div class="deploy__wizard-server">
              <span class="deploy__server-label" t-esc="state.server.label || state.server.host" />
              <span class="deploy__server-address">
                <t t-esc="state.server.username" />@<t t-esc="state.server.host" />:<t t-esc="state.server.port" />
              </span>
            </div>

            <div class="deploy__wizard-form">
              <label for="deploy__path-input">Chemin de déploiement</label>
              <input
                type="text"
                id="deploy__path-input"
                autocomplete="off"
                autocapitalize="off"
                t-model="state.deployPath"
              />
            </div>

            <div class="deploy__wizard-actions">
              <button class="deploy__btn-start"
                      t-on-click="() => this.beginDeployment()"
                      t-att-disabled="!state.deployPath">
                Déployer
              </button>
              <button class="deploy__btn-cancel"
                      t-on-click="() => window.history.back()">
                Annuler
              </button>
            </div>
          </div>
        </t>

        <!-- ── Déploiement en cours ──────────────────────────── -->
        <t t-if="state.phase === 'deploying' and state.deployment">
          <div class="deploy__server-info" t-if="state.server">
            <span class="deploy__server-label" t-esc="state.server.label || state.server.host" />
            <span class="deploy__server-address">
              <t t-esc="state.server.username" />@<t t-esc="state.server.host" />:<t t-esc="state.server.port" />
            </span>
            <span class="deploy__server-path">→ <t t-esc="state.deployment.path" /></span>
          </div>

          <ol class="deploy__steps">
            <t t-foreach="state.deployment.steps" t-as="step" t-key="step_index">
              <li t-att-class="'deploy__step deploy__step--' + step.status">

                <div class="deploy__step-header">
                  <span class="deploy__step-icon">
                    <t t-if="step.status === 'pending'">○</t>
                    <t t-elif="step.status === 'running'">
                      <span class="deploy__spinner">◌</span>
                    </t>
                    <t t-elif="step.status === 'success'">✓</t>
                    <t t-elif="step.status === 'warning'">⚠</t>
                    <t t-else="">✗</t>
                  </span>
                  <span class="deploy__step-label" t-esc="step.label" />
                  <span class="deploy__step-duration"
                        t-if="step.durationMs !== null"
                        t-esc="(step.durationMs / 1000).toFixed(1) + 's'" />
                </div>

                <div class="deploy__step-error"
                     t-if="step.errorMessage and step.status === 'error'">
                  <t t-esc="step.errorMessage" />
                </div>

                <div class="deploy__step-warning"
                     t-if="step.errorMessage and step.status === 'warning'">
                  <t t-esc="step.errorMessage" />
                </div>

                <details class="deploy__step-logs"
                         t-if="step.logs.length > 0"
                         t-on-toggle="(e) => this.onLogsToggle(e, step_index)">
                  <summary>
                    Journaux (<t t-esc="step.logs.length" /> lignes)
                    <span class="deploy__log-lock-indicator"
                          t-if="step.autoScroll">⬇ suivi</span>
                  </summary>
                  <div class="deploy__log-toolbar">
                    <button class="deploy__log-nav-btn"
                            title="Aller au début"
                            t-on-click="() => this.scrollLogToTop(step_index)">
                      ↑ Haut
                    </button>
                    <button class="deploy__log-nav-btn deploy__log-nav-btn--bottom"
                            title="Aller à la fin"
                            t-on-click="() => this.scrollLogToBottom(step_index)">
                      ↓ Bas
                    </button>
                  </div>
                  <pre
                    t-att-data-step="step_index"
                    class="deploy__log-output"
                    t-on-scroll="(e) => this.onLogScroll(e, step_index)"
                  ><t t-foreach="step.logs" t-as="log" t-key="log_index"><t t-esc="log" /><t t-if="!log_last">
</t></t></pre>
                </details>

                <!-- Bouton Réessayer par étape (si erreur ou warning) -->
                <t t-if="(step.status === 'error' or step.status === 'warning') and state.deployment.done">
                  <button class="deploy__btn-retry-step"
                          t-on-click="() => this.retryFromStep(step_index)">
                    ↩ Réessayer depuis cette étape
                  </button>
                </t>

              </li>
            </t>
          </ol>

          <div class="deploy__actions" t-if="state.deployment.done">
            <button class="deploy__btn-back"
                    t-on-click="() => window.history.back()">
              Retour
            </button>
            <button class="deploy__btn-retry"
                    t-if="state.deployment.failedStepIndex !== null"
                    t-on-click="() => this.retryFromStep(state.deployment.failedStepIndex)">
              Réessayer
            </button>
            <button class="deploy__btn-dismiss"
                    t-on-click="() => this.dismissDeployment()">
              Fermer
            </button>
          </div>

          <!-- Running: show a back-only bar -->
          <div class="deploy__actions" t-if="!state.deployment.done">
            <button class="deploy__btn-back"
                    t-on-click="() => window.history.back()">
              ← Retour (déploiement en arrière-plan)
            </button>
          </div>
        </t>

      </div>
    `;

    static components = { HeadingComponent };

    async setup() {
        const params = this.router.getRouteParams(
            window.location.pathname,
            "/servers/deploy/:host/:username"
        );
        const host = decodeURIComponent(params.get("host") ?? "");
        const username = decodeURIComponent(params.get("username") ?? "");

        this.state = useState({
            phase: "wizard" as "wizard" | "deploying",
            server: null as any,
            deployPath: "~/erplibre",
            deployment: null as ActiveDeployment | null,
        });

        // Auto-scroll: after each render, scroll to bottom for steps with autoScroll on
        onPatched(() => {
            this.scrollActiveLogContainers();
        });

        // ?path= param lets the Settings page pre-fill the deploy path
        const urlParams = new URLSearchParams(window.location.search);
        const pathParam = urlParams.get("path");

        try {
            const server = await this.serverService.getMatch({ host, username });
            this.state.server = server;
            this.state.deployPath = pathParam
                ? decodeURIComponent(pathParam)
                : server.deployPath || "~/erplibre";

            // Check for an in-progress / completed deployment to resume
            const normalizedPath = this.state.deployPath
                .replace(/^~\//, "$HOME/")
                .replace(/^~$/, "$HOME");
            const existing = this.deploymentService.find(host, username, normalizedPath);
            if (existing) {
                this.state.deployment = existing;
                this.state.phase = "deploying";
            }
        } catch (error: unknown) {
            // Server not found — show an error immediately
            this.state.phase = "deploying";
            this.state.deployment = this.deploymentService.create(
                { host, username, port: 22, authType: "password", password: "", privateKey: "", passphrase: "", label: host, deployPath: "" },
                ""
            );
            this.state.deployment.done = true;
            this.state.deployment.failedStepIndex = 0;
            this.state.deployment.steps[0].status = "error";
            this.state.deployment.steps[0].errorMessage = error instanceof Error
                ? error.message
                : "Serveur introuvable.";
        }
    }

    // ── Breadcrumbs ───────────────────────────────────────────────────────────

    get breadcrumbs() {
        const crumbs: { label: string; url: string }[] = [
            { label: "Applications", url: "/applications" },
        ];
        const s = this.state.server;
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

    // ── Wizard ───────────────────────────────────────────────────────────────

    async beginDeployment(): Promise<void> {
        const server = this.state.server;
        if (!server) return;

        // Normalize tilde: bash does NOT expand ~ inside double-quoted strings.
        const deployPath = this.state.deployPath
            .replace(/^~\//, "$HOME/")
            .replace(/^~$/, "$HOME");

        const dep = this.deploymentService.create(server, deployPath);
        this.state.deployment = dep;
        this.state.phase = "deploying";
        this.deploymentService.run(dep, 0);
    }

    // ── Retry ────────────────────────────────────────────────────────────────

    retryFromStep(fromStep: number): void {
        const dep = this.state.deployment;
        if (!dep || fromStep === null || fromStep === undefined) return;
        this.deploymentService.run(dep, fromStep);
    }

    dismissDeployment(): void {
        const dep = this.state.deployment;
        if (!dep) return;
        this.deploymentService.dismiss(dep.host, dep.username, dep.path);
        window.history.back();
    }

    // ── Auto-scroll ───────────────────────────────────────────────────────────

    private scrollActiveLogContainers(): void {
        const dep = this.state.deployment;
        if (!dep) return;
        dep.steps.forEach((step: any, i: number) => {
            if (!step.autoScroll) return;
            const el = document.querySelector<HTMLElement>(
                `#servers-deploy-component .deploy__log-output[data-step="${i}"]`
            );
            if (el) {
                el.scrollTop = el.scrollHeight;
            }
        });
    }

    scrollLogToTop(stepIndex: number): void {
        const el = document.querySelector<HTMLElement>(
            `#servers-deploy-component .deploy__log-output[data-step="${stepIndex}"]`
        );
        if (el) {
            el.scrollTop = 0;
            const dep = this.state.deployment;
            if (dep) dep.steps[stepIndex].autoScroll = false;
        }
    }

    scrollLogToBottom(stepIndex: number): void {
        const el = document.querySelector<HTMLElement>(
            `#servers-deploy-component .deploy__log-output[data-step="${stepIndex}"]`
        );
        if (el) {
            el.scrollTop = el.scrollHeight;
            const dep = this.state.deployment;
            if (dep) dep.steps[stepIndex].autoScroll = true;
        }
    }

    onLogScroll(event: Event, stepIndex: number): void {
        const el = event.target as HTMLElement;
        const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
        const dep = this.state.deployment;
        if (dep) dep.steps[stepIndex].autoScroll = isAtBottom;
    }

    onLogsToggle(event: Event, stepIndex: number): void {
        const details = event.target as HTMLDetailsElement;
        if (details.open) {
            const dep = this.state.deployment;
            if (dep) dep.steps[stepIndex].autoScroll = true;
        }
    }
}
