import { onMounted, useState, xml } from "@odoo/owl";

import { Dialog } from "@capacitor/dialog";

import { BiometryUtils } from "../../../utils/biometryUtils";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { ErrorMessages } from "../../../constants/errorMessages";

import { HeadingComponent } from "../../heading/heading_component";

export class ApplicationsEditComponent extends EnhancedComponent {
    static template = xml`
<div id="applications-edit-component">
    <HeadingComponent title="'Modifier une application'"/>
    <form
            id="app-edit__form"
            t-on-submit.prevent="onAppEditFormSubmit"
    >
        <div class="app-edit__form-group">
            <label for="app-edit__url">Adresse du site web</label>
            <input type="text" name="url" id="app-edit__url" autocomplete="off" autocapitalize="off"
                   placeholder="example.com" required="true" t-model="state.app.url"/>
        </div>
        <div class="app-edit__form-group">
            <label for="app-edit__username">Nom d'utilisateur</label>
            <input type="text" name="username" id="app-edit__username" autocomplete="off" autocapitalize="off"
                   placeholder="username" required="true" t-model="state.app.username"/>
        </div>
        <div class="app-edit__form-group">
            <label for="app-edit__ignore_password">Ignore password</label>
            <input type="checkbox" name="ignore_password" id="app-edit__ignore_password" autocomplete="off"
                   t-model="state.app.ignore_password"/>
        </div>
        <t t-if="!state.app.ignore_password">
            <div class="app-edit__form-group">
                <label for="app-edit__password">Mot de passe</label>
                <input type="password" name="password" id="app-edit__password" autocomplete="off" placeholder="password"
                       required="true" t-model="state.app.password"/>
            </div>
        </t>

        <details class="app-edit__sync-section">
            <summary class="app-edit__sync-summary">☁ Synchronisation Odoo</summary>

            <div class="app-edit__form-group">
                <label for="app-edit__database">Base de données Odoo</label>
                <div class="app-edit__db-row">
                    <input type="text" name="database" id="app-edit__database" autocomplete="off" autocapitalize="off"
                           placeholder="ex: ma_base" t-model="state.app.database"/>
                    <button type="button" class="app-edit__autocomplete-btn"
                            t-on-click="autocompleteDatabase"
                            t-att-disabled="state.isLoadingDb || !state.app.url">
                        <t t-if="state.isLoadingDb">…</t>
                        <t t-else="">Autocomplete</t>
                    </button>
                </div>
                <t t-if="state.detectedVersion">
                    <span class="app-edit__detected-version" t-esc="state.detectedVersion"/>
                </t>
            </div>

            <div class="app-edit__form-group">
                <label for="app-edit__auto_sync">Synchronisation automatique</label>
                <label class="app-edit__toggle">
                    <input type="checkbox" id="app-edit__auto_sync" t-model="state.app.autoSync"/>
                    <span t-esc="state.app.autoSync ? 'Activée' : 'Désactivée'"/>
                </label>
            </div>

            <t t-if="state.app.autoSync">
                <div class="app-edit__form-group">
                    <label for="app-edit__poll_interval">Intervalle de synchronisation</label>
                    <select id="app-edit__poll_interval" t-model="state.app.pollIntervalMinutes">
                        <option value="1">1 minute</option>
                        <option value="5">5 minutes</option>
                        <option value="15">15 minutes</option>
                        <option value="30">30 minutes</option>
                    </select>
                </div>
            </t>

            <details class="app-edit__ntfy-section">
                <summary class="app-edit__ntfy-summary">🔔 Notifications NTFY (optionnel)</summary>
                <div class="app-edit__form-group">
                    <label for="app-edit__ntfy_url">URL du serveur NTFY</label>
                    <input type="url" id="app-edit__ntfy_url" autocomplete="off"
                           placeholder="ex: https://ntfy.sh" t-model="state.app.ntfyUrl"/>
                </div>
                <div class="app-edit__form-group">
                    <label for="app-edit__ntfy_topic">Topic NTFY</label>
                    <input type="text" id="app-edit__ntfy_topic" autocomplete="off"
                           placeholder="ex: erplibre-monentreprise" t-model="state.app.ntfyTopic"/>
                </div>
                <p class="app-edit__ntfy-hint">
                    Configurez le même topic dans Odoo (Paramètres → ERPLibre Mobile).
                </p>
            </details>
        </details>

        <div class="app-edit__form-group app-edit__form-actions">
            <input type="submit" id="app-edit__submit" value="Modifier"/>
            <button type="button" id="app-edit__cancel" t-on-click="onCancelClick">Annuler</button>
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
        } catch {
            // App not found or migration not yet run — keep defaults
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
