import { useState, xml } from "@odoo/owl";

import { Dialog } from "@capacitor/dialog";

import { BiometryUtils } from "../../../utils/biometryUtils";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { ErrorMessages } from "../../../constants/errorMessages";

import { HeadingComponent } from "../../heading/heading_component";

export class ApplicationsAddComponent extends EnhancedComponent {
	static template = xml`
    <div id="applications-add-component">
      <HeadingComponent title="t('heading.add_application')" />
      <form
        id="app-add__form"
        t-on-submit="event => this.onAppAddFormSubmit(event)"
      >
        <div class="app-add__form-group">
          <label for="app-add__url"><t t-esc="t('label.website_address')"/></label>
          <input type="text" name="url" id="app-add__url" autocomplete="off" autocapitalize="off" t-att-placeholder="t('placeholder.example_url')" required="true" t-model="state.app.url" />
        </div>
        <div class="app-add__form-group">
          <label for="app-add__username"><t t-esc="t('label.username')"/></label>
          <input type="text" name="username" id="app-add__username" autocomplete="off" autocapitalize="off" t-att-placeholder="t('placeholder.username')" required="true" t-model="state.app.username" />
        </div>
        <div class="app-add__form-group">
          <label for="app-add__password"><t t-esc="t('label.password')"/></label>
          <input type="password" name="password" id="app-add__password" autocomplete="off" t-att-placeholder="t('placeholder.password')" required="true" t-model="state.app.password" />
        </div>

        <details class="app-add__sync-section">
          <summary class="app-add__sync-summary">☁ <t t-esc="t('section.odoo_sync_optional')"/></summary>

          <div class="app-add__form-group">
            <label for="app-add__database"><t t-esc="t('label.odoo_database')"/></label>
            <div class="app-add__db-row">
              <input type="text" id="app-add__database" autocomplete="off" autocapitalize="off"
                     t-att-placeholder="t('placeholder.database')" t-model="state.app.database" />
              <button type="button" class="app-add__autocomplete-btn"
                      t-on-click="autocompleteDatabase"
                      t-att-disabled="state.isLoadingDb || !state.app.url">
                <t t-if="state.isLoadingDb">…</t>
                <t t-else=""><t t-esc="t('button.autocomplete')"/></t>
              </button>
            </div>
            <t t-if="state.detectedVersion">
              <span class="app-add__detected-version" t-esc="state.detectedVersion" />
            </t>
          </div>

          <div class="app-add__form-group">
            <label for="app-add__auto_sync"><t t-esc="t('label.auto_sync')"/></label>
            <label class="app-add__toggle">
              <input type="checkbox" id="app-add__auto_sync" t-model="state.app.autoSync" />
              <span t-esc="state.app.autoSync ? 'Activée' : 'Désactivée'" />
            </label>
          </div>

          <t t-if="state.app.autoSync">
            <div class="app-add__form-group">
              <label for="app-add__poll_interval"><t t-esc="t('label.sync_interval')"/></label>
              <select id="app-add__poll_interval" t-model="state.app.pollIntervalMinutes">
                <option value="1"><t t-esc="t('sync_interval.1_min')"/></option>
                <option value="5"><t t-esc="t('sync_interval.5_min')"/></option>
                <option value="15"><t t-esc="t('sync_interval.15_min')"/></option>
                <option value="30"><t t-esc="t('sync_interval.30_min')"/></option>
              </select>
            </div>
          </t>

          <details class="app-add__ntfy-section">
            <summary class="app-add__ntfy-summary">🔔 <t t-esc="t('section.ntfy_optional')"/></summary>
            <div class="app-add__form-group">
              <label for="app-add__ntfy_url"><t t-esc="t('label.ntfy_server_url')"/></label>
              <input type="url" id="app-add__ntfy_url" autocomplete="off"
                     t-att-placeholder="t('placeholder.ntfy_url')" t-model="state.app.ntfyUrl" />
            </div>
            <div class="app-add__form-group">
              <label for="app-add__ntfy_topic"><t t-esc="t('label.ntfy_topic')"/></label>
              <input type="text" id="app-add__ntfy_topic" autocomplete="off"
                     t-att-placeholder="t('placeholder.ntfy_topic')" t-model="state.app.ntfyTopic" />
            </div>
            <p class="app-add__ntfy-hint">
              Configurez le même topic dans Odoo (Paramètres → ERPLibre Mobile).
            </p>
          </details>
        </details>

        <div class="app-add__form-group app-add__form-actions">
          <input type="submit" id="app-add__submit" value="Ajouter" />
          <button type="button" id="app-add__cancel" t-on-click="onCancelClick"><t t-esc="t('button.cancel')"/></button>
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
				database: "",
				odooVersion: "",
				autoSync: false,
				pollIntervalMinutes: 5,
				ntfyUrl: "",
				ntfyTopic: "",
			},
			isLoadingDb: false,
			detectedVersion: "",
		});
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

	async onAppAddFormSubmit(event): Promise<void> {
		event.preventDefault();

		if (this.state.app.url === "" || this.state.app.username === "" || this.state.app.password === "") {
			Dialog.alert({ message: ErrorMessages.EMPTY_FIELDS });
			return;
		}

		const isBiometricAuthSuccessful: boolean = await BiometryUtils.authenticateIfAvailable();

		if (!isBiometricAuthSuccessful) {
			Dialog.alert({ message: ErrorMessages.BIOMETRIC_AUTH });
			return;
		}

		const newApp = Object.assign({}, this.state.app);

		let saveSucceeded: boolean = false;

		try {
			saveSucceeded = await this.appService.add(newApp);
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
				return;
			}
		}

		if (!saveSucceeded) {
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
