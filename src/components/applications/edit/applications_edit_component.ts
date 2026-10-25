import { onMounted, useState, xml } from "@odoo/owl";

import { Dialog } from "@capacitor/dialog";

import { BiometryUtils } from "../../../utils/biometryUtils";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { ErrorMessages } from "../../../constants/errorMessages";

import { SyncService } from "../../../services/syncService";
import { networkService } from "../../../services/networkService";
import { syncConfigIdFor } from "../../../models/syncConfig";
import { CHAT_MAJOR, parseOdooMajor } from "../../../services/chat/chatSources";
import { installModule, moduleState, upgradeModule } from "../../../services/chat/chatModule";
import type { SyncCredentials } from "../../../services/odoo/odooRpcClient";
import { t } from "../../../i18n";

import { HeadingComponent } from "../../heading/heading_component";

export class ApplicationsEditComponent extends EnhancedComponent {
    static template = xml`
<div id="applications-edit-component">
    <HeadingComponent title="t('heading.edit_application')"/>
    <form
            id="app-edit__form"
            t-on-submit.prevent="onAppEditFormSubmit"
    >
        <div class="app-edit__form-group">
            <label for="app-edit__url"><t t-esc="t('label.website_address')"/></label>
            <input type="text" name="url" id="app-edit__url" autocomplete="off" autocapitalize="off"
                   t-att-placeholder="t('placeholder.example_url')" required="true" t-model="state.app.url"/>
        </div>
        <div class="app-edit__form-group">
            <label for="app-edit__username"><t t-esc="t('label.username')"/></label>
            <input type="text" name="username" id="app-edit__username" autocomplete="off" autocapitalize="off"
                   t-att-placeholder="t('placeholder.username')" required="true" t-model="state.app.username"/>
        </div>
        <div class="app-edit__form-group">
            <label for="app-edit__ignore_password"><t t-esc="t('button.ignore_password')"/></label>
            <input type="checkbox" name="ignore_password" id="app-edit__ignore_password" autocomplete="off"
                   t-model="state.app.ignore_password"/>
        </div>
        <t t-if="!state.app.ignore_password">
            <div class="app-edit__form-group">
                <label for="app-edit__password"><t t-esc="t('label.password')"/></label>
                <input type="password" name="password" id="app-edit__password" autocomplete="off" t-att-placeholder="t('placeholder.password')"
                       required="true" t-model="state.app.password"/>
            </div>
        </t>

        <details class="app-edit__sync-section">
            <summary class="app-edit__sync-summary">☁ <t t-esc="t('section.odoo_sync')"/></summary>

            <div class="app-edit__form-group">
                <label for="app-edit__database"><t t-esc="t('label.odoo_database')"/></label>
                <div class="app-edit__db-row">
                    <input type="text" name="database" id="app-edit__database" autocomplete="off" autocapitalize="off"
                           t-att-placeholder="t('placeholder.database')" t-model="state.app.database"/>
                    <button type="button" class="app-edit__autocomplete-btn"
                            t-on-click="autocompleteDatabase"
                            t-att-disabled="state.isLoadingDb || !state.app.url">
                        <t t-if="state.isLoadingDb">…</t>
                        <t t-else=""><t t-esc="t('button.autocomplete')"/></t>
                    </button>
                </div>
                <t t-if="state.detectedVersion">
                    <span class="app-edit__detected-version" t-esc="state.detectedVersion"/>
                </t>
                <t t-if="state.chatModule">
                    <span class="app-edit__detected-version app-edit__chat-module" t-esc="t('chat.module_' + state.chatModule)"/>
                    <button type="button" class="app-edit__autocomplete-btn app-edit__chat-install"
                            t-if="state.chatModule === 'available'"
                            t-att-disabled="state.chatInstalling"
                            t-on-click="installChatModule">
                        <t t-if="state.chatInstalling"><t t-esc="t('chat.module_installing')"/></t>
                        <t t-else=""><t t-esc="t('chat.module_install')"/></t>
                    </button>
                    <button type="button" class="app-edit__autocomplete-btn app-edit__chat-upgrade"
                            t-if="state.chatCanUpgrade"
                            t-att-disabled="state.chatInstalling"
                            t-on-click="upgradeChatModule">
                        <t t-if="state.chatInstalling"><t t-esc="t('chat.module_upgrading')"/></t>
                        <t t-else=""><t t-esc="t('chat.module_upgrade')"/></t>
                    </button>
                    <span class="app-edit__chat-error" t-if="state.chatError" t-esc="state.chatError"/>
                </t>
            </div>

            <div class="app-edit__form-group">
                <label for="app-edit__auto_sync"><t t-esc="t('label.auto_sync')"/></label>
                <label class="app-edit__toggle">
                    <input type="checkbox" id="app-edit__auto_sync" t-model="state.app.autoSync"/>
                    <span t-esc="state.app.autoSync ? 'Activée' : 'Désactivée'"/>
                </label>
            </div>

            <t t-if="state.app.autoSync">
                <div class="app-edit__form-group">
                    <label for="app-edit__poll_interval"><t t-esc="t('label.sync_interval')"/></label>
                    <select id="app-edit__poll_interval" t-model="state.app.pollIntervalMinutes">
                        <option value="1"><t t-esc="t('sync_interval.1_min')"/></option>
                        <option value="5"><t t-esc="t('sync_interval.5_min')"/></option>
                        <option value="15"><t t-esc="t('sync_interval.15_min')"/></option>
                        <option value="30"><t t-esc="t('sync_interval.30_min')"/></option>
                    </select>
                </div>
            </t>

            <details class="app-edit__ntfy-section">
                <summary class="app-edit__ntfy-summary">🔔 <t t-esc="t('section.ntfy_optional')"/></summary>
                <div class="app-edit__form-group">
                    <label for="app-edit__ntfy_url"><t t-esc="t('label.ntfy_server_url')"/></label>
                    <input type="url" id="app-edit__ntfy_url" autocomplete="off"
                           t-att-placeholder="t('placeholder.ntfy_url')" t-model="state.app.ntfyUrl"/>
                </div>
                <div class="app-edit__form-group">
                    <label for="app-edit__ntfy_topic"><t t-esc="t('label.ntfy_topic')"/></label>
                    <input type="text" id="app-edit__ntfy_topic" autocomplete="off"
                           t-att-placeholder="t('placeholder.ntfy_topic')" t-model="state.app.ntfyTopic"/>
                </div>
                <p class="app-edit__ntfy-hint">
                    Configurez le même topic dans Odoo (Paramètres → ERPLibre Mobile).
                </p>
            </details>
        </details>

        <div class="app-edit__form-group app-edit__form-actions">
            <input type="submit" id="app-edit__submit" value="Modifier"/>
            <button type="button" id="app-edit__cancel" t-on-click="onCancelClick"><t t-esc="t('button.cancel')"/></button>
        </div>
    </form>
</div>
  `;

    static components = { HeadingComponent };

    setup() {
        this.state = useState({
            app: {
                url: "",
                username: "",
                password: "",
                ignore_password: true,
                database: "",
                odooVersion: "",
                autoSync: false,
                pollIntervalMinutes: 5,
                ntfyUrl: "",
                ntfyTopic: "",
            },
            originalAppID: {
                url: "",
                username: "",
            },
            isLoadingDb: false,
            detectedVersion: "",
            chatModule: "",
            chatInstalling: false,
            chatCanUpgrade: false,
            chatError: "",
        });

        this.setParams();
        onMounted(() => this.loadAppData());
    }

    async autocompleteDatabase(): Promise<void> {
        const url = this.state.app.url;
        if (!url) return;
        this.state.isLoadingDb = true;
        this.state.detectedVersion = "";
        try {
            const [databases, version] = await Promise.all([
                this.syncService.listDatabases(url),
                this.syncService.getServerVersion(url),
            ]);
            if (version) {
                this.state.app.odooVersion = version;
                this.state.detectedVersion = `Odoo ${version}`;
                // Persist immediately so it shows on next open without re-running Autocomplete
                await this.appService.setOdooVersion(this.state.originalAppID, version);
            }
            if (databases.length === 0) {
                Dialog.alert({ message: "Aucune base de données trouvée sur ce serveur." });
            } else if (databases.length === 1) {
                this.state.app.database = databases[0];
            } else {
                const list = databases.map((db, i) => `${i + 1}. ${db}`).join("\n");
                const choice = window.prompt(`Plusieurs bases trouvées:\n${list}\n\nEntrez le numéro ou le nom:`);
                if (!choice) return;
                const idx = parseInt(choice, 10);
                if (!isNaN(idx) && idx >= 1 && idx <= databases.length) {
                    this.state.app.database = databases[idx - 1];
                } else if (databases.includes(choice)) {
                    this.state.app.database = choice;
                } else {
                    Dialog.alert({ message: `Base de données introuvable: ${choice}` });
                }
            }
        } catch (error: unknown) {
            Dialog.alert({ message: error instanceof Error ? error.message : "Erreur lors de la récupération des bases." });
        } finally {
            this.state.isLoadingDb = false;
        }
    }

    async onAppEditFormSubmit(): Promise<void> {
        if (
            this.state.app.url === "" ||
            this.state.app.username === "" ||
            (this.state.app.ignore_password === false && this.state.app.password === "")
        ) {
            return;
        }

        const isBiometricAuthSuccessful: boolean = await BiometryUtils.authenticateIfAvailable();

        if (!isBiometricAuthSuccessful) {
            Dialog.alert({ message: ErrorMessages.BIOMETRIC_AUTH });
            return;
        }

        let saveSucceeded: boolean = false;

        const ignore = this.state.app.ignore_password === true;

        try {
            saveSucceeded = await this.appService.edit(this.state.originalAppID, this.state.app, {
                ignorePassword: ignore,
            });
        } catch (error: unknown) {
            if (error instanceof Error) {
                Dialog.alert({ message: error.message });
                return;
            }
        }

        if (!saveSucceeded) {
            Dialog.alert({ message: ErrorMessages.APP_SAVE });
            return;
        }

        this.notificationService.reload();
        this.clearFormFields();
        window.history.back();
    }

    onCancelClick(): void {
        this.clearFormFields();
        window.history.back();
    }

    private async loadAppData(): Promise<void> {
        try {
            const app = await this.appService.getMatch({
                url: this.state.app.url,
                username: this.state.app.username,
            });
            this.state.app.database = app.database ?? "";
            this.state.app.odooVersion = app.odooVersion ?? "";
            this.state.app.autoSync = app.autoSync ?? false;
            this.state.app.pollIntervalMinutes = app.pollIntervalMinutes ?? 5;
            this.state.app.ntfyUrl = app.ntfyUrl ?? "";
            this.state.app.ntfyTopic = app.ntfyTopic ?? "";
            if (app.odooVersion) {
                this.state.detectedVersion = `Odoo ${app.odooVersion}`;
            }
            this.chatApp = app;
        } catch {
            // App not found or migration not yet run — keep defaults
            return;
        }
        await this.loadChatModule();
    }

    private chatApp: any = null;

    /** Credentials and sync config id of the stored app, null without a database. */
    private chatTarget(): { creds: ReturnType<typeof SyncService.credentialsFrom>; configId: string } | null {
        const app = this.chatApp;
        if (!app || !app.database) return null;
        return {
            creds: SyncService.credentialsFrom(app, app.database),
            configId: syncConfigIdFor(app.url, app.username, app.database),
        };
    }

    /**
     * Shows the chat server module state for an app whose stored version is
     * Odoo 18; a blank or other version shows nothing, as the stored string
     * is cheaper than a login to ask the server. A failed probe reads
     * "unknown". Runs after the form data, so it never delays the form.
     */
    private async loadChatModule(): Promise<void> {
        const target = this.chatTarget();
        if (!target || parseOdooMajor(this.chatApp.odooVersion ?? "") !== CHAT_MAJOR) return;
        try {
            const online = await networkService.isOnline();
            this.state.chatModule = await moduleState(
                this.syncService.rpc, this.syncService.capabilities, target.creds, { online }
            );
            await this.refreshChatCanUpgrade(target.creds);
        } catch {
            this.state.chatModule = "unknown";
        }
    }

    /** The upgrade is offered to a system user on an outdated module only; a failed check hides it. */
    private async refreshChatCanUpgrade(creds: SyncCredentials): Promise<void> {
        this.state.chatCanUpgrade = false;
        if (this.state.chatModule !== "outdated") return;
        try {
            this.state.chatCanUpgrade = (await this.syncService.rpc.sessionInfo(creds)).isSystem;
        } catch {
            this.state.chatCanUpgrade = false;
        }
    }

    /** Upgrades the module for a system user, persists and shows the state returned; a failure shows an error line. */
    async upgradeChatModule(): Promise<void> {
        const target = this.chatTarget();
        if (!target || !this.state.chatCanUpgrade || this.state.chatInstalling) return;
        this.state.chatInstalling = true;
        this.state.chatError = "";
        try {
            const next = await upgradeModule(this.syncService.rpc, this.syncService.capabilities, target.creds);
            await this.chatService.repo.setSourceState({ configId: target.configId, moduleState: next });
            this.state.chatModule = next;
            await this.refreshChatCanUpgrade(target.creds);
        } catch {
            this.state.chatError = t("chat.module_upgrade_error");
        } finally {
            this.state.chatInstalling = false;
        }
    }

    /** Installs the module, persists and shows the state returned; a failure shows an error line. */
    async installChatModule(): Promise<void> {
        const target = this.chatTarget();
        if (!target || this.state.chatInstalling) return;
        this.state.chatInstalling = true;
        this.state.chatError = "";
        try {
            const next = await installModule(this.syncService.rpc, this.syncService.capabilities, target.creds);
            await this.chatService.repo.setSourceState({ configId: target.configId, moduleState: next });
            this.state.chatModule = next;
        } catch {
            this.state.chatError = t("chat.module_install_error");
        } finally {
            this.state.chatInstalling = false;
        }
    }

    private setParams() {
        const params = this.router.getRouteParams(window.location.pathname, "/applications/edit/:url/:username");
        this.state.app.url = decodeURIComponent(params?.get("url") || "");
        this.state.app.username = decodeURIComponent(params?.get("username") || "");
        this.state.originalAppID.url = this.state.app.url;
        this.state.originalAppID.username = this.state.app.username;
    }

    private clearFormFields(): void {
        this.state.app.url = "";
        this.state.app.username = "";
        this.state.app.password = "";
        this.state.app.database = "";
        this.state.app.odooVersion = "";
        this.state.app.autoSync = false;
        this.state.app.ntfyUrl = "";
        this.state.app.ntfyTopic = "";
    }
}
