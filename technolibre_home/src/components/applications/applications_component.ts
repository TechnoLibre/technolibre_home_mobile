import { useState, xml } from "@odoo/owl";

import { Dialog } from "@capacitor/dialog";

import { Application, ApplicationID } from "../../models/application";
import { BiometryUtils } from "../../utils/biometryUtils";
import { EnhancedComponent } from "../../js/enhancedComponent";
import { ErrorMessages } from "../../constants/errorMessages";
import { Events } from "../../constants/events";
import { WebViewUtils } from "../../utils/webViewUtils";

import { ApplicationsItemComponent } from "./item/applications_item_component";
import { HeadingComponent } from "../heading/heading_component";

export class ApplicationsComponent extends EnhancedComponent {
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

	async setup() {
		this.state = useState({ applications: new Array<Application>() });

		this.state.applications = await this.appService.getApps();
	}

	onAppAddClick(event) {
		event.preventDefault();

		this.eventBus.trigger(Events.ROUTER_NAVIGATION, { url: "/applications/add" });
	}

	async openApplication(appID: ApplicationID) {
		const isBiometricAuthSuccessful = await BiometryUtils.authenticateIfAvailable();

		if (!isBiometricAuthSuccessful) {
			Dialog.alert({ message: ErrorMessages.BIOMETRIC_AUTH });
			return;
		}

		let matchingApp: Application | undefined;

		try {
			matchingApp = await this.appService.getMatch(appID);
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
(() => {
  // ==== Helpers ====
  function getElementByXPath(xpath, context = document) {
    const result = document.evaluate(
      xpath, context, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
    );
    return result.singleNodeValue || null;
  }

  function waitForXPathWithObserver(xpath, { timeout = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      const found = getElementByXPath(xpath);
      if (found) return resolve(found);

      let settled = false;
      const observer = new MutationObserver(() => {
        const el = getElementByXPath(xpath);
        if (el) {
          settled = true;
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });

      setTimeout(() => {
        if (settled) return;
        observer.disconnect();
        reject(new Error("Timeout en attendant l'élément XPath: " + xpath));
      }, timeout);
    });
  }

  // Affecte proprement la valeur d'un input (déclenche les events usuels)
  function setInputValue(el, value) {
    try {
      const proto = Object.getPrototypeOf(el);
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      el.value = value;
    }
  }

  // ==== XPaths ciblés (Odoo: ids "login" et "password") ====
  const USER_XPATH = "//*[@id='login']";
  const PASS_XPATH = "//*[@id='password']";
  // Bouton: type submit ou texte courant (FR/EN)
  const SUBMIT_XPATH = "//button[@type='submit' or contains(normalize-space(.), 'Log in') or contains(normalize-space(.), 'Se connecter')]";

  // ==== Flow ====
  Promise.all([
    waitForXPathWithObserver(USER_XPATH, { timeout: 15000 }),
    waitForXPathWithObserver(PASS_XPATH, { timeout: 15000 })
  ])
  .then(([userEl, passEl]) => {
    setInputValue(userEl, "${matchingApp.username}");
    setInputValue(passEl, "${matchingApp.password}");

    // (Optionnel) Cliquer sur le bouton submit s'il apparaît rapidement
    return waitForXPathWithObserver(SUBMIT_XPATH, { timeout: 5000 })
      .then(btn => {
        btn.scrollIntoView({ block: 'center', inline: 'center' });
        // petit rafraîchissement de layout avant le click
        requestAnimationFrame(() => {
          btn.click();
          console.log('[loginScript] Submit cliqué via XPath');
        });
      })
      .catch(() => {
        // Pas de bouton trouvé: on laisse l'utilisateur soumettre manuellement
        console.log('[loginScript] Bouton submit non trouvé dans le délai, champs pré-remplis.');
      });
  })
  .catch(err => {
    console.error('[loginScript] Erreur:', err);
  });
})();
`;

		let url_rewrite_odoo = "https://" + matchingApp.url + "/web/login";

		if (WebViewUtils.isMobile()) {
			// TODO how catch error
			WebViewUtils.openWebViewMobile({
				url: url_rewrite_odoo,
				title: matchingApp.url,
				isPresentAfterPageLoad: true,
				preShowScript: loginScript,
				enabledSafeBottomMargin: true,
				// useTopInset: true,
				activeNativeNavigationForWebview: true,
			});
		} else {
			WebViewUtils.openWebViewDesktop(url_rewrite_odoo, loginScript);
		}
	}

	async editApplication(appID: ApplicationID) {
		const encodedURL = encodeURIComponent(appID.url);
		const encodedUsername = encodeURIComponent(appID.username);
		this.eventBus.trigger(Events.ROUTER_NAVIGATION, {
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

		const deleteSucceeded: boolean = await this.appService.delete(appID);

		if (!deleteSucceeded) {
			Dialog.alert({ message: ErrorMessages.APP_DELETE });
			return;
		}

		this.state.applications = await this.appService.getApps();
	}
}
