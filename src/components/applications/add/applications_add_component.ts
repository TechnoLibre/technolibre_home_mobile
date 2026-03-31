import { useState, xml } from "@odoo/owl";

import { Dialog } from "@capacitor/dialog";

import { BiometryUtils } from "../../../utils/biometryUtils";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { ErrorMessages } from "../../../constants/errorMessages";

import { HeadingComponent } from "../../heading/heading_component";

export class ApplicationsAddComponent extends EnhancedComponent {
	static template = xml`
    <div id="applications-add-component">
      <HeadingComponent title="'Ajouter une application'" />
      <form
        id="app-add__form"
        t-on-submit="event => this.onAppAddFormSubmit(event)"
      >
        <div class="app-add__form-group">
          <label for="app-add__url">Adresse du site web</label>
          <input type="text" name="url" id="app-add__url" autocomplete="off" autocapitalize="off" placeholder="example.com" required="true" t-model="state.app.url" />
        </div>
        <div class="app-add__form-group">
          <label for="app-add__username">Nom d'utilisateur</label>
          <input type="text" name="username" id="app-add__username" autocomplete="off" autocapitalize="off" placeholder="jean_tremblay" required="true" t-model="state.app.username" />
        </div>
        <div class="app-add__form-group">
          <label for="app-add__password">Mot de passe</label>
          <input type="password" name="password" id="app-add__password" autocomplete="off" placeholder="mot_de_passe" required="true" t-model="state.app.password" />
        </div>

        <details class="app-add__sync-section">
          <summary class="app-add__sync-summary">☁ Synchronisation Odoo (optionnel)</summary>

          <div class="app-add__form-group">
            <label for="app-add__database">Base de données Odoo</label>
            <input type="text" id="app-add__database" autocomplete="off" autocapitalize="off"
                   placeholder="ex: ma_base" t-model="state.app.database" />
          </div>

          <div class="app-add__form-group">
            <label for="app-add__auto_sync">Synchronisation automatique</label>
            <label class="app-add__toggle">
              <input type="checkbox" id="app-add__auto_sync" t-model="state.app.autoSync" />
              <span t-esc="state.app.autoSync ? 'Activée' : 'Désactivée'" />
            </label>
          </div>

          <t t-if="state.app.autoSync">
            <div class="app-add__form-group">
              <label for="app-add__poll_interval">Intervalle de synchronisation</label>
              <select id="app-add__poll_interval" t-model="state.app.pollIntervalMinutes">
                <option value="1">1 minute</option>
                <option value="5">5 minutes</option>
                <option value="15">15 minutes</option>
                <option value="30">30 minutes</option>
              </select>
            </div>
          </t>

          <details class="app-add__ntfy-section">
            <summary class="app-add__ntfy-summary">🔔 Notifications NTFY (optionnel)</summary>
            <div class="app-add__form-group">
              <label for="app-add__ntfy_url">URL du serveur NTFY</label>
              <input type="url" id="app-add__ntfy_url" autocomplete="off"
                     placeholder="ex: https://ntfy.sh" t-model="state.app.ntfyUrl" />
            </div>
            <div class="app-add__form-group">
              <label for="app-add__ntfy_topic">Topic NTFY</label>
              <input type="text" id="app-add__ntfy_topic" autocomplete="off"
                     placeholder="ex: erplibre-monentreprise" t-model="state.app.ntfyTopic" />
            </div>
            <p class="app-add__ntfy-hint">
              Configurez le même topic dans Odoo (Paramètres → ERPLibre Mobile).
            </p>
          </details>
        </details>

        <div class="app-add__form-group app-add__form-actions">
          <input type="submit" id="app-add__submit" value="Ajouter" />
          <button type="button" id="app-add__cancel" t-on-click="onCancelClick">Annuler</button>
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
				autoSync: false,
				pollIntervalMinutes: 5,
				ntfyUrl: "",
				ntfyTopic: "",
			},
		});
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
		this.state.app.autoSync = false;
		this.state.app.ntfyUrl = "";
		this.state.app.ntfyTopic = "";
	}
}
