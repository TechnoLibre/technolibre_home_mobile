import { useState, onPatched, xml } from "@odoo/owl";
import type { PluginListenerHandle } from "@capacitor/core";

import { Server } from "../../../models/server";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { HeadingComponent } from "../../heading/heading_component";
import { SshPlugin } from "../../../plugins/sshPlugin";

type StepStatus = "pending" | "running" | "success" | "warning" | "error";

interface DeployStep {
    label: string;
    status: StepStatus;
    durationMs: number | null;
    errorMessage: string | null;
    logs: string[];
    autoScroll: boolean;
}

export class ServersDeployComponent extends EnhancedComponent {
    static template = xml`
      <div id="servers-deploy-component">
        <HeadingComponent title="'Déploiement ERPLibre'" />

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
        <t t-if="state.phase === 'deploying'">
          <div class="deploy__server-info" t-if="state.server">
            <span class="deploy__server-label" t-esc="state.server.label || state.server.host" />
            <span class="deploy__server-address">
              <t t-esc="state.server.username" />@<t t-esc="state.server.host" />:<t t-esc="state.server.port" />
            </span>
            <span class="deploy__server-path">→ <t t-esc="state.deployPath" /></span>
          </div>

          <ol class="deploy__steps">
            <t t-foreach="state.steps" t-as="step" t-key="step_index">
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
                  <summary>Journaux (<t t-esc="step.logs.length" /> lignes)</summary>
                  <pre
                    t-att-data-step="step_index"
                    class="deploy__log-output"
                    t-on-scroll="(e) => this.onLogScroll(e, step_index)"
                  ><t t-foreach="step.logs" t-as="log" t-key="log_index"><t t-esc="log" /><t t-if="!log_last">
</t></t></pre>
                </details>

                <!-- Bouton Réessayer par étape (si erreur ou warning) -->
                <t t-if="(step.status === 'error' or step.status === 'warning') and state.done">
                  <button class="deploy__btn-retry-step"
                          t-on-click="() => this.retryFromStep(step_index)">
                    ↩ Réessayer depuis cette étape
                  </button>
                </t>

              </li>
            </t>
          </ol>

          <div class="deploy__actions" t-if="state.done">
            <button class="deploy__btn-back"
                    t-on-click="() => window.history.back()">
              Retour
            </button>
            <button class="deploy__btn-retry"
                    t-if="state.failedStepIndex !== null"
                    t-on-click="() => this.retryFromStep(state.failedStepIndex)">
              Réessayer
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
            server: null as Server | null,
            deployPath: "~/erplibre",
            steps: [
                this.makeStep("Connexion SSH"),
                this.makeStep("Clonage du dépôt ERPLibre"),
                this.makeStep("Installation (make install)"),
            ] as DeployStep[],
            done: false,
            failedStepIndex: null as number | null,
        });

        // Auto-scroll: after each render, scroll to bottom for steps with autoScroll on
        onPatched(() => {
            this.scrollActiveLogContainers();
        });

        try {
            const server = await this.serverService.getMatch({ host, username });
            this.state.server = server;
            this.state.deployPath = server.deployPath || "~/erplibre";
        } catch (error: unknown) {
            this.state.phase = "deploying";
            this.state.done = true;
            this.state.failedStepIndex = 0;
            this.state.steps[0].status = "error";
            this.state.steps[0].errorMessage = error instanceof Error
                ? error.message
                : "Serveur introuvable.";
        }
    }

    private makeStep(label: string): DeployStep {
        return { label, status: "pending", durationMs: null, errorMessage: null, logs: [], autoScroll: true };
    }

    // ── Wizard ───────────────────────────────────────────────────────────────

    async beginDeployment(): Promise<void> {
        this.state.phase = "deploying";
        await this.startDeployment(0);
    }

    // ── Retry ────────────────────────────────────────────────────────────────

    async retryFromStep(fromStep: number): Promise<void> {
        if (fromStep === null || fromStep === undefined) return;
        await this.startDeployment(fromStep);
    }

    // ── Main deployment logic ─────────────────────────────────────────────────

    async startDeployment(fromStep: number): Promise<void> {
        const server = this.state.server;
        if (!server) return;

        // Step 0 (SSH) always resets and reruns — it must reconnect before any step.
        // Steps from fromStep onwards also reset.
        for (let i = 0; i < this.state.steps.length; i++) {
            if (i === 0 || i >= fromStep) {
                const step = this.state.steps[i];
                step.status = "pending";
                step.durationMs = null;
                step.errorMessage = null;
                step.logs = [];
                step.autoScroll = true;
            }
        }
        this.state.done = false;
        this.state.failedStepIndex = null;

        const deployPath = this.state.deployPath;
        let outputListener: PluginListenerHandle | null = null;

        try {
            // Step 0: SSH Connection — ALWAYS runs, regardless of fromStep
            await this.runStep(0, async () => {
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
            });

            // Attach output listener (streams to the currently-running step)
            outputListener = await SshPlugin.addListener("sshOutput", (data) => {
                const activeStep = this.state.steps.find((s) => s.status === "running");
                if (activeStep) {
                    activeStep.logs.push(`[${data.stream}] ${data.line}`);
                }
            });

            // Step 1: git clone (or skip if repo already present)
            if (fromStep <= 1) {
                await this.runStepGitClone(deployPath);
            }

            // Step 2: make install
            if (fromStep <= 2) {
                await this.runStep(2, async () => {
                    const result = await SshPlugin.execute({
                        command: `cd ${deployPath} && make install`,
                    });
                    if (result.exitCode !== 0) {
                        throw new Error(`make install a échoué (code ${result.exitCode})`);
                    }
                });
            }

        } catch (_error) {
            // Error already recorded by runStep / runStepGitClone
        } finally {
            if (outputListener) {
                await outputListener.remove();
            }
            try { await SshPlugin.disconnect(); } catch (_e) { /* ignore */ }

            // Find the first failed step to expose on the global Réessayer button
            const failedIdx = this.state.steps.findIndex(
                (s) => s.status === "error"
            );
            this.state.failedStepIndex = failedIdx >= 0 ? failedIdx : null;
            this.state.done = true;
        }
    }

    // Step 1: if directory exists → cd (verify access, warning); else git clone
    private async runStepGitClone(deployPath: string): Promise<void> {
        const step = this.state.steps[1];
        step.status = "running";
        const start = Date.now();

        try {
            const checkResult = await SshPlugin.execute({
                command: `test -d "${deployPath}"`,
            });

            if (checkResult.exitCode === 0) {
                // Directory already exists — cd to verify access
                const cdResult = await SshPlugin.execute({
                    command: `cd "${deployPath}" && pwd`,
                });
                step.durationMs = Date.now() - start;
                if (cdResult.exitCode !== 0) {
                    step.status = "error";
                    step.errorMessage = `Impossible d'accéder au répertoire ${deployPath}`;
                    throw new Error(step.errorMessage);
                }
                step.status = "warning";
                step.errorMessage = `Le répertoire ${deployPath} existe déjà — passage à l'étape suivante.`;
                return;
            }

            // Directory absent — git clone
            const cloneResult = await SshPlugin.execute({
                command: `git clone https://github.com/erplibre/erplibre "${deployPath}"`,
            });
            step.durationMs = Date.now() - start;

            if (cloneResult.exitCode !== 0) {
                step.status = "error";
                step.errorMessage = `git clone a échoué (code ${cloneResult.exitCode})`;
                throw new Error(step.errorMessage);
            }

            step.status = "success";
        } catch (error: unknown) {
            if (step.status !== "warning" && step.status !== "error") {
                step.durationMs = Date.now() - start;
                step.status = "error";
                step.errorMessage = error instanceof Error ? error.message : "Erreur inconnue.";
            }
            if (step.status === "error") {
                throw error;
            }
        }
    }

    private async runStep(index: number, fn: () => Promise<void>): Promise<void> {
        const step = this.state.steps[index];
        if (!step) return;

        step.status = "running";
        const start = Date.now();

        try {
            await fn();
            step.durationMs = Date.now() - start;
            step.status = "success";
        } catch (error: unknown) {
            step.durationMs = Date.now() - start;
            step.status = "error";
            step.errorMessage = error instanceof Error ? error.message : "Erreur inconnue.";
            throw error;
        }
    }

    // ── Auto-scroll ───────────────────────────────────────────────────────────

    private scrollActiveLogContainers(): void {
        this.state.steps.forEach((step, i) => {
            if (!step.autoScroll) return;
            // Find the pre element for this step by data-step attribute
            const el = document.querySelector<HTMLElement>(
                `#servers-deploy-component .deploy__log-output[data-step="${i}"]`
            );
            if (el) {
                el.scrollTop = el.scrollHeight;
            }
        });
    }

    onLogScroll(event: Event, stepIndex: number): void {
        const el = event.target as HTMLElement;
        // If user scrolled up (not at the bottom), disable auto-scroll
        const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
        if (!isAtBottom) {
            this.state.steps[stepIndex].autoScroll = false;
        } else {
            this.state.steps[stepIndex].autoScroll = true;
        }
    }

    onLogsToggle(event: Event, stepIndex: number): void {
        const details = event.target as HTMLDetailsElement;
        if (details.open) {
            // Re-enable auto-scroll when the log section is opened
            this.state.steps[stepIndex].autoScroll = true;
        }
    }
}
