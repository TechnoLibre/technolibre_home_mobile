import {useState, xml} from "@odoo/owl";

import {Dialog} from "@capacitor/dialog";

import {Application, ApplicationID} from "../../models/application";
import {BiometryUtils} from "../../utils/biometryUtils";
import {EnhancedComponent} from "../../js/enhancedComponent";
import {ErrorMessages} from "../../constants/errorMessages";
import {Events} from "../../constants/events";
import {WebViewUtils} from "../../utils/webViewUtils";

import {ApplicationsItemComponent} from "./item/applications_item_component";
import {HeadingComponent} from "../heading/heading_component";

const ENV = {
    // @ts-ignore
    TITLE: import.meta.env.VITE_TITLE ?? "TITLE",
    // @ts-ignore
    BUTTON_LABEL: import.meta.env.VITE_BUTTON_LABEL ?? "Connexion",
    // @ts-ignore
    LOGO_KEY: import.meta.env.VITE_LOGO_KEY ?? "techno",
    // @ts-ignore
    WEBSITE_URL: import.meta.env.VITE_WEBSITE_URL ?? "https://erplibre.ca",
    // @ts-ignore
    DEBUG_DEV: import.meta.env.VITE_DEBUG_DEV === "true",
};

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

    static components = {HeadingComponent, ApplicationsItemComponent};

    async setup() {
        this.state = useState({applications: new Array<Application>()});

        this.state.applications = await this.appService.getApps();

        this.state.debug = ENV.DEBUG_DEV;
    }

    onAppAddClick(event) {
        event.preventDefault();

        this.eventBus.trigger(Events.ROUTER_NAVIGATION, {url: "/applications/add"});
    }

    async openApplication(appID: ApplicationID) {
        const isBiometricAuthSuccessful = await BiometryUtils.authenticateIfAvailable();

        if (!isBiometricAuthSuccessful) {
            Dialog.alert({message: ErrorMessages.BIOMETRIC_AUTH});
            return;
        }

        let matchingApp: Application | undefined;

        try {
            matchingApp = await this.appService.getMatch(appID);
        } catch (error: unknown) {
            if (error instanceof Error) {
                Dialog.alert({message: error.message});
                return;
            }
        }

        if (!matchingApp) {
            Dialog.alert({message: ErrorMessages.NO_APP_MATCH});
            return;
        }

        /* const loginScriptLoop = `const inputUsername = document.getElementById(\"login\"); const inputPassword = document.getElementById(\"password\"); const inputSubmit = document.querySelector(\"button[type='submit']\"); if (!inputUsername || !inputPassword || !inputSubmit) { return; } inputUsername.value = \"${matchingApp.username}\"; inputPassword.value = \"${matchingApp.password}\"; inputSubmit.click();`; */

        // This script support auto-login and fix infinite loop
        const loginScript = `
(async () => {
  // ==== Helpers généraux ====
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function getElementByXPath(xpath, context = document) {
    const result = document.evaluate(xpath, context, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
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

      observer.observe(document.documentElement, { childList: true, subtree: true });

      setTimeout(() => {
        if (settled) return;
        observer.disconnect();
        reject(new Error("Timeout en attendant l'élément XPath: " + xpath));
      }, timeout);
    });
  }

  function setInputValue(el, value) {
    try {
      const proto = Object.getPrototypeOf(el);
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && descriptor.set) descriptor.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch {
      el.value = value;
    }
  }

  // ==== Détection d'erreur avec délai ====
  const ERROR_ALERT_SEL = '.alert.alert-danger';

  // version synchrone (instantanée)
  function hasErrorAlertSync() {
    return !!document.querySelector(ERROR_ALERT_SEL);
  }

  // attend 'ms' millisecondes avant de tester
  async function hasErrorAlertAfter(ms = 300) {
    await sleep(ms);
    return hasErrorAlertSync();
  }

  // garantit une "fenêtre sans erreur" : on échantillonne pendant 'windowMs'
  // toutes les 'pollMs'; si une alerte apparaît, on échoue.
  async function waitNoErrorWindow(windowMs = 1200, pollMs = 150) {
    const start = Date.now();
    while (Date.now() - start < windowMs) {
      if (hasErrorAlertSync()) return false;
      await sleep(pollMs);
    }
    return true;
  }

  // ==== XPaths ciblés (Odoo) ====
  const USER_XPATH   = "//*[@id='login']";
  const PASS_XPATH   = "//*[@id='password']";
  const SUBMIT_XPATH = "//button[@type='submit' or contains(normalize-space(.), 'Log in') or contains(normalize-space(.), 'Se connecter')]";

  // ==== Anti-boucle (flag global) ====
  if (window.__autoLoginSubmitted) return;

  // petit délai initial avant toute lecture du DOM (la page peut animer/flash)
  if (await hasErrorAlertAfter(400)) {
    console.warn('[loginScript] Alerte présente au démarrage → on n\\'agit pas.');
    return;
  }

  try {
    const [userEl, passEl] = await Promise.all([
      waitForXPathWithObserver(USER_XPATH, { timeout: 15000 }),
      waitForXPathWithObserver(PASS_XPATH, { timeout: 15000 })
    ]);

    setInputValue(userEl, "${matchingApp.username}");
    setInputValue(passEl, "${matchingApp.password}");

    // petite pause pour laisser les validations côté client se déclencher
    await sleep(250);

    // si une erreur apparaît juste après remplissage, on stoppe
    if (!(await waitNoErrorWindow(1000, 200))) {
      console.warn('[loginScript] Alerte détectée après remplissage → pas de submit.');
      return;
    }

    const btn = await waitForXPathWithObserver(SUBMIT_XPATH, { timeout: 5000 }).catch(() => null);
    if (!btn) {
      console.log('[loginScript] Pas de bouton submit rapidement; on s\\'arrête après pré-remplissage.');
      return;
    }

    // dernière vérif avec "fenêtre sans erreur" juste avant de cliquer
    if (await hasErrorAlertAfter(200)) {
      console.warn('[loginScript] Alerte présente juste avant le clic → on annule.');
      return;
    }

    if (!(await waitNoErrorWindow(600, 150))) {
      console.warn('[loginScript] Alerte sur la fenêtre de stabilité → on annule.');
      return;
    }

    window.__autoLoginSubmitted = true;
    btn.scrollIntoView({ block: 'center', inline: 'center' });
    await new Promise(r => requestAnimationFrame(r));
    btn.click();
    console.log('[loginScript] Submit cliqué via XPath');

  } catch (err) {
    console.error('[loginScript] Erreur:', err);
  }

  // observer pour geler tout automatisme si une alerte apparaît après coup
  const errObserver = new MutationObserver(() => {
    if (hasErrorAlertSync()) {
      window.__autoLoginSubmitted = true;
      errObserver.disconnect();
      console.warn('[loginScript] Alerte détectée (observer) → désactivation auto-login.');
    }
  });
  errObserver.observe(document.documentElement, { childList: true, subtree: true });
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
            url: `/applications/edit/${encodedURL}/${encodedUsername}`,
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
            Dialog.alert({message: ErrorMessages.BIOMETRIC_AUTH});
            return;
        }

        const deleteSucceeded: boolean = await this.appService.delete(appID);

        if (!deleteSucceeded) {
            Dialog.alert({message: ErrorMessages.APP_DELETE});
            return;
        }

        this.state.applications = await this.appService.getApps();
    }
}
