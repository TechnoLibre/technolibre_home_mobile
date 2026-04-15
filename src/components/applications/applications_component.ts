import {onWillDestroy, useState, xml} from "@odoo/owl";

import {Dialog} from "@capacitor/dialog";
import {Capacitor} from "@capacitor/core";
import type {PluginListenerHandle} from "@capacitor/core";

import {Application, ApplicationID} from "../../models/application";
import {Server, ServerID} from "../../models/server";
import {BiometryUtils} from "../../utils/biometryUtils";
import {EnhancedComponent} from "../../js/enhancedComponent";
import {ErrorMessages} from "../../constants/errorMessages";
import {Events} from "../../constants/events";
import {WebViewUtils} from "../../utils/webViewUtils";
import {NetworkScanPlugin} from "../../plugins/networkScanPlugin";
import type {ScannedHost} from "../../plugins/networkScanPlugin";

import {ApplicationsItemComponent} from "./item/applications_item_component";
import {ServersItemComponent} from "../servers/item/servers_item_component";
import {HeadingComponent} from "../heading/heading_component";

interface ScanResult extends ScannedHost {
    added: boolean;
    alreadyExists: boolean;
}

const ENV = {
    // @ts-ignore
    TITLE: import.meta.env.VITE_TITLE ?? "TITLE",
    // @ts-ignore
    LABEL_NOTE: import.meta.env.VITE_LABEL_NOTE ?? "Note",
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
        <HeadingComponent title="t('nav.applications')" />
        <section id="applications">
          <div id="applications-options">
            <button class="section__btn-toggle"
                    t-att-aria-expanded="state.showApps ? 'true' : 'false'"
                    aria-controls="applications-list"
                    t-on-click="() => this.state.showApps = !this.state.showApps">
              <t t-if="state.showApps"><t t-esc="t('button.hide')"/> (<t t-esc="state.applications.length" />)</t>
              <t t-else=""><t t-esc="t('button.show')"/> (<t t-esc="state.applications.length" />)</t>
            </button>
            <a
              id="applications-add"
              href="#"
              role="button"
              t-att-aria-label="t('button.add_application')"
              t-on-click.stop.prevent="onAppAddClick"
              t-esc="t('button.add_application')"
            />
          </div>
          <t t-if="state.showApps">
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
              <p t-esc="t('message.no_applications')" />
            </div>
          </t>
        </section>

        <HeadingComponent title="t('nav.servers')" />
        <section id="servers">
          <div id="servers-options">
            <button class="section__btn-toggle"
                    t-att-aria-expanded="state.showServers ? 'true' : 'false'"
                    aria-controls="servers-list"
                    t-on-click="() => this.state.showServers = !this.state.showServers">
              <t t-if="state.showServers"><t t-esc="t('button.hide')"/> (<t t-esc="state.servers.length" />)</t>
              <t t-else=""><t t-esc="t('button.show')"/> (<t t-esc="state.servers.length" />)</t>
            </button>
            <button id="servers-scan"
                    t-if="isNative"
                    t-att-disabled="state.isScanning"
                    t-att-aria-label="state.isScanning ? t('label.scan_in_progress') : t('button.scan_network')"
                    t-on-click="onScanClick">
              <t t-if="!state.isScanning" t-esc="t('label.scan')"/>
              <t t-else="" t-esc="t('label.scanning')"/>
            </button>
            <button id="servers-scan-cancel"
                    t-if="state.isScanning"
                    t-att-aria-label="t('button.cancel_scan')"
                    t-on-click="onScanCancel"
                    t-esc="t('button.cancel')"
            />
            <a
              id="servers-add"
              href="#"
              role="button"
              t-att-aria-label="t('button.add_server')"
              t-on-click.stop.prevent="onServerAddClick"
              t-esc="t('button.add_server')"
            />
          </div>

          <!-- ── Scan results panel ── -->
          <div t-if="state.scannedHosts.length > 0" id="servers-scan-results">
            <div class="scan-results__header">
              <span><t t-esc="t('section.ssh_machines')"/> (<t t-esc="state.scannedHosts.length" />)</span>
              <button class="scan-results__close" t-on-click="clearScanResults">✕</button>
            </div>
            <t t-foreach="state.scannedHosts" t-as="found" t-key="found.host">
              <div class="scan-host">
                <div class="scan-host__info">
                  <span class="scan-host__ip" t-esc="found.host" />
                  <span t-if="found.hostname" class="scan-host__hostname" t-esc="found.hostname" />
                  <span class="scan-host__banner" t-esc="found.banner" />
                </div>
                <t t-if="found.alreadyExists">
                  <span class="scan-host__tag scan-host__tag--exists" t-esc="t('label.already_in_list')" />
                </t>
                <t t-elif="found.added">
                  <span class="scan-host__tag scan-host__tag--added" t-esc="t('label.added')" />
                </t>
                <t t-else="">
                  <button class="scan-host__btn"
                          t-att-data-host="found.host"
                          t-on-click="onAddScannedHostClick"
                          t-esc="t('button.add')"
                  />
                </t>
              </div>
            </t>
          </div>

          <t t-if="state.showServers">
            <ul id="servers-list" t-if="state.servers.length != 0">
              <ServersItemComponent
                t-foreach="state.servers"
                t-as="server"
                t-key="server.host + ':' + server.username"
                server="server"
                deleteServer.bind="deleteServer"
                editServer.bind="editServer"
              />
            </ul>
            <div id="servers-empty" t-else="">
              <p t-esc="t('message.no_servers')" />
            </div>
          </t>
        </section>
      </div>
    `;

    static components = {HeadingComponent, ApplicationsItemComponent, ServersItemComponent};

    private _scanListener: PluginListenerHandle | null = null;

    async setup() {
        this.state = useState({
            applications:  new Array<Application>(),
            servers:       new Array<Server>(),
            showApps:      false,
            showServers:   false,
            isScanning:    false,
            scannedHosts:  [] as ScanResult[],
        });

        onWillDestroy(() => {
            if (this._scanListener) {
                this._scanListener.remove().catch(() => {});
                this._scanListener = null;
            }
            if (this.state.isScanning) {
                NetworkScanPlugin.cancelScan().catch(() => {});
            }
        });

        this.state.applications = await this.appService.getApps();
        this.state.servers = await this.serverService.getServers();
        this.state.debug = ENV.DEBUG_DEV;
    }

    get isNative(): boolean {
        return Capacitor.isNativePlatform();
    }

    // ── Scan ──────────────────────────────────────────────────────────────────

    async onScanClick() {
        if (this.state.isScanning) return;

        this.state.isScanning   = true;
        this.state.scannedHosts = [];
        this.state.showServers  = true;

        // Pre-load existing hosts to mark duplicates immediately
        const existing     = await this.serverService.getServers();
        const existingHosts = new Set(existing.map(s => s.host));

        this._scanListener = await NetworkScanPlugin.addListener("hostFound", (found) => {
            this.state.scannedHosts.push({
                ...found,
                added:         false,
                alreadyExists: existingHosts.has(found.host),
            });
        });

        try {
            await NetworkScanPlugin.scan({ timeoutMs: 500 });
        } catch {
            // Cancelled or network error — results already accumulated
        } finally {
            if (this._scanListener) {
                await this._scanListener.remove();
                this._scanListener = null;
            }
            this.state.isScanning = false;
        }
    }

    async onScanCancel() {
        await NetworkScanPlugin.cancelScan();
    }

    clearScanResults() {
        this.state.scannedHosts = [];
    }

    async onAddScannedHostClick(event: MouseEvent) {
        const host  = (event.currentTarget as HTMLElement).dataset.host!;
        const found = this.state.scannedHosts.find(h => h.host === host);
        if (!found) return;

        // Use hostname if available, otherwise fall back to the IP.
        // e.g. "ubuntu-server.local @ 192.168.1.5" or "192.168.1.5"
        const label = found.hostname ? found.hostname + " @ " + host : host;

        try {
            await this.serverService.add({
                host:       host,
                port:       found.port,
                username:   "",
                authType:   "password",
                password:   "",
                privateKey: "",
                passphrase: "",
                label:      label,
                deployPath: "~/erplibre",
            });
            found.added = true;
            this.state.servers = await this.serverService.getServers();
        } catch {
            // ServerAlreadyExistsError or host already present under different username
            found.alreadyExists = true;
        }
    }

    // ── Server CRUD ───────────────────────────────────────────────────────────

    onAppAddClick(event: Event) {
        event.preventDefault();
        this.eventBus.trigger(Events.ROUTER_NAVIGATION, {url: "/applications/add"});
    }

    // ── Servers ───────────────────────────────────────────────────────────────

    onServerAddClick(event: Event) {
        event.preventDefault();
        this.eventBus.trigger(Events.ROUTER_NAVIGATION, {url: "/servers/add"});
    }

    async editServer(serverID: ServerID) {
        const qs = new URLSearchParams({ host: serverID.host, username: serverID.username });
        this.eventBus.trigger(Events.ROUTER_NAVIGATION, { url: `/servers/edit?${qs}` });
    }

    async deleteServer(serverID: ServerID) {
        const deleteSucceeded = await this.serverService.delete(serverID).catch((error: unknown) => {
            Dialog.alert({message: error instanceof Error ? error.message : ErrorMessages.SERVER_DELETE});
            return false;
        });

        if (deleteSucceeded) {
            this.state.servers = await this.serverService.getServers();
        }
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
  const SUBMIT_XPATH = "//button[@type='submit' and (contains(normalize-space(.), 'Log in') or contains(normalize-space(.), 'Se connecter') or contains(normalize-space(.), 'Connexion'))]";

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

        const baseUrl = /^https?:\/\//i.test(matchingApp.url) ? matchingApp.url : "https://" + matchingApp.url;
        let url_rewrite_odoo = baseUrl + "/web/login";

        if (WebViewUtils.isMobile()) {
            // TODO how catch error
            WebViewUtils.openWebViewMobile({
                url: url_rewrite_odoo,
                title: matchingApp.url,
                isPresentAfterPageLoad: true,
                preShowScript: WebViewUtils.safeAreaScript() + "\n" + loginScript,
                enabledSafeBottomMargin: true,
                toolbarColor: "#1a1a1a",
                toolbarTextColor: "#ffffff",
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
            this.t("dialog.confirm_delete_app", { url: appID.url, username: appID.username })
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
