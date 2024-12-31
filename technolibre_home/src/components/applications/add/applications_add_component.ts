import { Component, useState, xml } from "@odoo/owl";

import { Dialog } from "@capacitor/dialog";

import { BiometryUtils } from "../../../utils/biometryUtils";
import { ErrorMessages } from "../../../js/errors";

import { HeadingComponent } from "../../heading/heading_component";

export class ApplicationsAddComponent extends Component {
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
        <div class="app-add__form-group">
          <input type="submit" id="app-add__submit" value="Ajouter" />
        </div>
      </form>
    </div>
  `;

	static components = { HeadingComponent };

	state: any = undefined;

	setup() {
		this.state = useState({
			app: {
				url: "",
				username: "",
				password: ""
			}
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
			saveSucceeded = await this.env.appService.add(newApp);
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
				return;
			}
		}

		if (!saveSucceeded) {
			return;
		}

		this.clearFormFields();
		window.history.back();
	}

	private clearFormFields(): void {
		this.state.app.url = "";
		this.state.app.username = "";
		this.state.app.password = "";
	}
}
