import { reactive } from "@odoo/owl";
import type { PluginListenerHandle } from "@capacitor/core";

import { Server } from "../models/server";
import { SshPlugin } from "../plugins/sshPlugin";
import { ServerService } from "./serverService";

export type StepStatus = "pending" | "running" | "success" | "warning" | "error";

export interface DeployStep {
    label: string;
    status: StepStatus;
    durationMs: number | null;
    errorMessage: string | null;
    logs: string[];
    autoScroll: boolean;
}

export interface ActiveDeployment {
    host: string;
    username: string;
    path: string;        // normalized ($HOME expanded)
    server: Server;
    steps: DeployStep[];
    done: boolean;
    failedStepIndex: number | null;
    startedAt: number;
}

function makeStep(label: string): DeployStep {
    return {
        label,
        status: "pending",
        durationMs: null,
        errorMessage: null,
        logs: [],
        autoScroll: true,
    };
}

/**
 * Global deployment registry.
 *
 * Deployments are stored as Owl reactive objects so components can subscribe
 * to step / log changes. The SSH output listener captures the reactive dep
 * directly, so logs accumulate even when no component is mounted.
 */
export class DeploymentService {
    /**
     * Reactive list — any component reading this during render will
     * automatically re-render when deployments are added or removed.
     */
    readonly deployments: ActiveDeployment[] = reactive([]);

    /** key → reactive dep (for fast lookup without going through the array proxy) */
    private readonly _map = new Map<string, ActiveDeployment>();

    /** key → active SSH output listener handle (removed after deployment ends) */
    private readonly _listeners = new Map<string, PluginListenerHandle>();

    constructor(private readonly _serverService: ServerService) {}

    // ── Registry ──────────────────────────────────────────────────────────────

    private _key(host: string, username: string, path: string): string {
        return `${host}\x00${username}\x00${path}`;
    }

    find(host: string, username: string, path: string): ActiveDeployment | undefined {
        return this._map.get(this._key(host, username, path));
    }

    getAllForServer(host: string, username: string): ActiveDeployment[] {
        return this.deployments.filter(
            (d) => d.host === host && d.username === username
        );
    }

    /**
     * Create a fresh reactive deployment entry.
     * If one already exists for (host, username, path) it is replaced.
     */
    create(server: Server, path: string): ActiveDeployment {
        // Remove stale entry if any
        this.dismiss(server.host, server.username, path);

        const dep: ActiveDeployment = reactive({
            host: server.host,
            username: server.username,
            path,
            server,
            steps: [
                makeStep("Connexion SSH"),
                makeStep("Clonage du dépôt ERPLibre"),
                makeStep("Installation (make install)"),
            ],
            done: false,
            failedStepIndex: null,
            startedAt: Date.now(),
        });

        this.deployments.push(dep);
        this._map.set(this._key(server.host, server.username, path), dep);
        return dep;
    }

    /** Remove a deployment from the registry (after user dismisses). */
    dismiss(host: string, username: string, path: string): void {
        const key = this._key(host, username, path);
        const idx = this.deployments.findIndex(
            (d) => d.host === host && d.username === username && d.path === path
        );
        if (idx >= 0) this.deployments.splice(idx, 1);
        this._map.delete(key);
        this._listeners.get(key)?.remove().catch(() => {});
        this._listeners.delete(key);
    }

    // ── SSH execution ─────────────────────────────────────────────────────────

    /**
     * Start (or restart from a given step) the deployment.
     * Returns immediately — runs in the background.
     * All state changes go through the reactive `dep` object so any mounted
     * component will re-render, and logs accumulate even without a viewer.
     */
    run(dep: ActiveDeployment, fromStep: number): void {
        this._runAsync(dep, fromStep).catch(() => {
            // Individual step errors are already written to dep.steps
        });
    }

    private async _runAsync(dep: ActiveDeployment, fromStep: number): Promise<void> {
        const key = this._key(dep.host, dep.username, dep.path);

        // Remove any stale listener from a previous retry
        const oldListener = this._listeners.get(key);
        if (oldListener) {
            await oldListener.remove().catch(() => {});
            this._listeners.delete(key);
        }

        // Reset steps (step 0 always resets; steps ≥ fromStep reset)
        for (let i = 0; i < dep.steps.length; i++) {
            if (i === 0 || i >= fromStep) {
                const s = dep.steps[i];
                s.status = "pending";
                s.durationMs = null;
                s.errorMessage = null;
                s.logs = [];
                s.autoScroll = true;
            }
        }
        dep.done = false;
        dep.failedStepIndex = null;

        const deployPath = dep.path;
        let listener: PluginListenerHandle | null = null;

        try {
            // ── Step 0: SSH connection ────────────────────────────────────────
            await this._runStep(dep, 0, async () => {
                const credential = dep.server.authType === "password"
                    ? dep.server.password
                    : dep.server.privateKey;
                await SshPlugin.connect({
                    host: dep.server.host,
                    port: dep.server.port,
                    username: dep.server.username,
                    authType: dep.server.authType,
                    credential,
                    passphrase: dep.server.passphrase || undefined,
                });
            });

            // Attach listener — persists independently of any component lifecycle
            listener = await SshPlugin.addListener("sshOutput", (data) => {
                const active = dep.steps.find((s) => s.status === "running");
                if (active) {
                    active.logs.push(`[${data.stream}] ${data.line}`);
                }
            });
            this._listeners.set(key, listener);

            // ── Step 1: git clone (or skip if dir already present) ────────────
            if (fromStep <= 1) {
                await this._runStepGitClone(dep, deployPath);
            }

            // ── Step 2: make install ──────────────────────────────────────────
            if (fromStep <= 2) {
                await this._runStep(dep, 2, async () => {
                    const result = await SshPlugin.execute({
                        command: `cd "${deployPath}" && make install`,
                    });
                    if (result.exitCode !== 0) {
                        throw new Error(`make install a échoué (code ${result.exitCode})`);
                    }
                });
            }

        } catch (_err) {
            // Individual errors are already recorded in step objects
        } finally {
            if (listener) {
                await listener.remove().catch(() => {});
                this._listeners.delete(key);
            }
            try { await SshPlugin.disconnect(); } catch (_e) { /* ignore */ }

            const failedIdx = dep.steps.findIndex((s) => s.status === "error");
            dep.failedStepIndex = failedIdx >= 0 ? failedIdx : null;

            // Persist workspace on full success
            if (failedIdx < 0) {
                try {
                    await this._serverService.addWorkspace({
                        host: dep.host,
                        username: dep.username,
                        path: dep.path,
                    });
                } catch (_e) { /* ignore duplicates */ }
            }

            dep.done = true;
        }
    }

    private async _runStep(
        dep: ActiveDeployment,
        index: number,
        fn: () => Promise<void>
    ): Promise<void> {
        const step = dep.steps[index];
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

    private async _runStepGitClone(dep: ActiveDeployment, deployPath: string): Promise<void> {
        const step = dep.steps[1];
        step.status = "running";
        const start = Date.now();

        try {
            const checkResult = await SshPlugin.execute({
                command: `test -d "${deployPath}"`,
            });

            if (checkResult.exitCode === 0) {
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
            if (step.status === "error") throw error;
        }
    }
}
