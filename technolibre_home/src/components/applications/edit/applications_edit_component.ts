import { useState, xml } from "@odoo/owl";

import { Dialog } from "@capacitor/dialog";

import { BiometryUtils } from "../../../utils/biometryUtils";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { ErrorMessages } from "../../../constants/errorMessages";

import { HeadingComponent } from "../../heading/heading_component";

export class ApplicationsEditComponent extends EnhancedComponent {
	static template = xml`
    <div id="applications-edit-component">
      <HeadingComponent title="'Modifier une application'" />
      <form
        id="app-edit__form"
        t-on-submit.prevent="onAppEditFormSubmit"
      >
        <div class="app-edit__form-group">
          <label for="app-edit__url">Adresse du site web</label>
          <input type="text" name="url" id="app-edit__url" autocomplete="off" autocapitalize="off" placeholder="example.com" required="true" t-model="state.app.url" />
        </div>
        <div class="app-edit__form-group">
          <label for="app-edit__username">Nom d'utilisateur</label>
          <input type="text" name="username" id="app-edit__username" autocomplete="off" autocapitalize="off" placeholder="jean_tremblay" required="true" t-model="state.app.username" />
        </div>
        <div class="app-edit__form-group">
          <label for="app-edit__password">Mot de passe</label>
          <input type="password" name="password" id="app-edit__password" autocomplete="off" placeholder="mot_de_passe" required="true" t-model="state.app.password" />
        </div>
        <div class="app-edit__form-group">
          <input type="submit" id="app-edit__submit" value="Modifier" />
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
				password: ""
			},
			originalAppID: {
				url: "",
				username: ""
			}
		});

		this.setParams();
	}

	async onAppEditFormSubmit(): Promise<void> {
		if (this.state.app.url === "" || this.state.app.username === "" || this.state.app.password === "") {
			return;
		}

		const isBiometricAuthSuccessful: boolean = await BiometryUtils.authenticateIfAvailable();

		if (!isBiometricAuthSuccessful) {
			Dialog.alert({ message: ErrorMessages.BIOMETRIC_AUTH });
			return;
		}

		let saveSucceeded: boolean = false;

		try {
			saveSucceeded = await this.appService.edit(this.state.originalAppID, this.state.app);
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

		this.clearFormFields();
		window.history.back();
	}

	private setParams() {
		const params = this.router.getRouteParams(window.location.pathname);
		this.state.app.url = decodeURIComponent(params["url"]);
		this.state.app.username = decodeURIComponent(params["username"]);
		this.state.originalAppID.url = this.state.app.url;
		this.state.originalAppID.username = this.state.app.username;
	}

	private clearFormFields(): void {
		this.state.app.url = "";
		this.state.app.username = "";
		this.state.app.password = "";
	}
}
