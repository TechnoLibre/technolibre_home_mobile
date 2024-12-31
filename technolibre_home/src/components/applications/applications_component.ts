import { Component, useState, xml } from "@odoo/owl";

import { Dialog } from "@capacitor/dialog";

import { Application, ApplicationID } from "./types";
import { BiometryUtils } from "../../utils/biometryUtils";
import { Constants } from "../../js/constants";
import { ErrorMessages } from "../../js/errors";
import { WebViewUtils } from "../../utils/webViewUtils";

import { ApplicationsItemComponent } from "./item/applications_item_component";
import { HeadingComponent } from "../heading/heading_component";

export class ApplicationsComponent extends Component {
	static template = xml`
      <div id="applications-component">
        <HeadingComponent title="'Applications'" />
        <section id="applications">
          <div id="applications-options">
            <a
              id="applications-add"
              t-on-click="event => this.onAppAddClick(event)"
            >
              Ajouter
            </a>
          </div>
          <ul id="applications-list" t-if="state.applications.length != 0">
            <ApplicationsItemComponent
              t-foreach="state.applications"
              t-as="app"
              t-key="app.url + ':' + app.username"
              app="app"
              openApp.bind="openApplication"
              editApp.bind="editApplication"
              deleteApp.bind="deleteApplication"
            />
          </ul>
          <div id="applications-empty" t-else="">
            <p>Il n'y a pas d'application dans le stockage local.</p>
          </div>
        </section>
      </div>
    `;

	static components = { HeadingComponent, ApplicationsItemComponent };

	state: any = undefined;

	async setup() {
		this.state = useState({ applications: new Array<Application>() });

		this.state.applications = await this.env.appService.getApps();
	}

	onAppAddClick(event) {
		event.preventDefault();

		this.env.eventBus.trigger(Constants.ROUTER_NAVIGATION_EVENT_NAME, { url: "/applications/add" });
	}

	async openApplication(appID: ApplicationID) {
		const isBiometricAuthSuccessful = await BiometryUtils.authenticateIfAvailable();

		if (!isBiometricAuthSuccessful) {
			Dialog.alert({ message: ErrorMessages.BIOMETRIC_AUTH });
			return;
		}

		let matchingApp: Application | undefined;

		try {
			matchingApp = await this.env.appService.getMatch(appID);
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
				return;
			}
		}

		if (!matchingApp) {
			Dialog.alert({ message: ErrorMessages.NO_APP_MATCH });
			return;
		}

		// TODO FIX Infinite loop.
		// The page submits, but if the login information is incorrect, it keeps executing the script.
		// This results in an infinite loop of the page having the fields filled and the form submitting.
		/* const loginScriptLoop = `const inputUsername = document.getElementById(\"login\"); const inputPassword = document.getElementById(\"password\"); const inputSubmit = document.querySelector(\"button[type='submit']\"); if (!inputUsername || !inputPassword || !inputSubmit) { return; } inputUsername.value = \"${matchingApp.username}\"; inputPassword.value = \"${matchingApp.password}\"; inputSubmit.click();`; */

		const loginScript = `
        const inputUsername = document.getElementById(\"login\");
        const inputPassword = document.getElementById(\"password\");
        if (!inputUsername || !inputPassword) { return; };
        inputUsername.value = \"${matchingApp.username}\";
        inputPassword.value = \"${matchingApp.password}\";
      `;

		let url_rewrite_odoo = "https://" + matchingApp.url + "/web/login";

		if (WebViewUtils.isMobile()) {
			// TODO how catch error
			WebViewUtils.openWebViewMobile({
				url: url_rewrite_odoo,
				title: matchingApp.url,
				isPresentAfterPageLoad: true,
				preShowScript: loginScript
			});
		} else {
			WebViewUtils.openWebViewDesktop(url_rewrite_odoo, loginScript);
		}
	}

	async editApplication(appID: ApplicationID) {
		const encodedURL = encodeURIComponent(appID.url);
		const encodedUsername = encodeURIComponent(appID.username);
		this.env.eventBus.trigger(Constants.ROUTER_NAVIGATION_EVENT_NAME, {
			url: `/applications/edit/${encodedURL}/${encodedUsername}`
		});
	}

	async deleteApplication(appID: ApplicationID) {
		const deleteConfirmed = confirm(
			`Voulez-vous vraiment supprimer l'application ${appID.url} pour le compte ${appID.username}?`
		);

		if (!deleteConfirmed) {
			return;
		}

		const isBiometricAuthSuccessful: boolean = await BiometryUtils.authenticateIfAvailable();

		if (!isBiometricAuthSuccessful) {
			Dialog.alert({ message: ErrorMessages.BIOMETRIC_AUTH });
			return;
		}

		const deleteSucceeded: boolean = await this.env.appService.delete(appID);

		if (!deleteSucceeded) {
			Dialog.alert({ message: ErrorMessages.APP_DELETE });
			return;
		}

		this.state.applications = await this.env.appService.getApps();
	}
}
