import { useState, xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";

import { BiometryUtils } from "../../../utils/biometryUtils";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { ErrorMessages } from "../../../constants/errorMessages";
import { HeadingComponent } from "../../heading/heading_component";

export class ServersEditComponent extends EnhancedComponent {
    static template = xml`
      <div id="servers-edit-component">
        <HeadingComponent title="'Modifier un serveur'" />
        <form id="server-edit__form" t-on-submit="event => this.onSubmit(event)">

          <div class="server-edit__form-group">
            <label for="server-edit__label">Nom du serveur (optionnel)</label>
            <input type="text" id="server-edit__label" autocomplete="off"
                   placeholder="ex: Serveur Production" t-model="state.server.label" />
          </div>

          <div class="server-edit__form-group">
            <label for="server-edit__host">Hôte SSH</label>
            <input type="text" id="server-edit__host" autocomplete="off" autocapitalize="off"
                   placeholder="ex: 192.168.1.10" required="true"
                   t-model="state.server.host" />
          </div>

          <div class="server-edit__form-group">
            <label for="server-edit__port">Port SSH</label>
            <input type="number" id="server-edit__port" min="1" max="65535"
                   t-model="state.server.port" />
          </div>

          <div class="server-edit__form-group">
            <label for="server-edit__username">Nom d'utilisateur SSH</label>
            <input type="text" id="server-edit__username" autocomplete="off" autocapitalize="off"
                   required="true" t-model="state.server.username" />
          </div>

          <div class="server-edit__form-group">
            <label for="server-edit__deploy-path">Chemin de déploiement</label>
            <input type="text" id="server-edit__deploy-path" autocomplete="off" autocapitalize="off"
                   t-model="state.server.deployPath" />
          </div>

          <div class="server-edit__form-group">
            <label>Type d'authentification</label>
            <div class="server-edit__auth-type">
              <label class="server-edit__radio-label">
                <input type="radio" name="authType" value="password"
                       t-att-checked="state.server.authType === 'password'"
                       t-on-change="() => this.onAuthTypeChange('password')" />
                Mot de passe
              </label>
              <label class="server-edit__radio-label">
                <input type="radio" name="authType" value="key"
                       t-att-checked="state.server.authType === 'key'"
                       t-on-change="() => this.onAuthTypeChange('key')" />
                Clé privée SSH
              </label>
            </div>
          </div>

          <div class="server-edit__form-group">
            <label class="server-edit__toggle">
              <input type="checkbox" t-model="state.ignoreCredential" />
              Conserver les identifiants actuels
            </label>
          </div>

          <t t-if="!state.ignoreCredential">
            <t t-if="state.server.authType === 'password'">
              <div class="server-edit__form-group">
                <label for="server-edit__password">Mot de passe SSH</label>
                <input type="password" id="server-edit__password" autocomplete="off"
                       t-model="state.server.password" />
              </div>
            </t>
            <t t-if="state.server.authType === 'key'">
              <div class="server-edit__form-group">
                <label for="server-edit__private-key">Clé privée (contenu PEM)</label>
                <textarea id="server-edit__private-key" rows="6"
                          t-model="state.server.privateKey" />
              </div>
              <div class="server-edit__form-group">
                <label for="server-edit__passphrase">Passphrase (optionnel)</label>
                <input type="password" id="server-edit__passphrase" autocomplete="off"
                       t-model="state.server.passphrase" />
              </div>
            </t>
          </t>

          <div class="server-edit__form-group server-edit__form-actions">
            <input type="submit" id="server-edit__submit" value="Enregistrer" />
            <button type="button" id="server-edit__cancel" t-on-click="onCancelClick">Annuler</button>
          </div>

        </form>
      </div>
    `;

    static components = { HeadingComponent };

    async setup() {
        const params = this.router.getRouteParams(
            window.location.pathname,
            "/servers/edit/:host/:username"
        );
        const host = decodeURIComponent(params.get("host") ?? "");
        const username = decodeURIComponent(params.get("username") ?? "");

        this.state = useState({
            server: {
                host: "",
                port: 22,
                username: "",
                authType: "password" as "password" | "key",
                password: "",
                privateKey: "",
                passphrase: "",
                label: "",
                deployPath: "~/erplibre",
            },
            ignoreCredential: true,
            originalHost: host,
            originalUsername: username,
        });

        try {
            const server = await this.serverService.getMatch({ host, username });
            Object.assign(this.state.server, server);
        } catch (error: unknown) {
            Dialog.alert({ message: error instanceof Error ? error.message : ErrorMessages.NO_SERVER_MATCH });
        }
    }

    onAuthTypeChange(type: "password" | "key"): void {
        this.state.server.authType = type;
    }

    async onSubmit(event: Event): Promise<void> {
        event.preventDefault();

        const s = this.state.server;

        if (!s.host || !s.username) {
            Dialog.alert({ message: ErrorMessages.EMPTY_FIELDS });
            return;
        }

        const isBiometricAuthSuccessful = await BiometryUtils.authenticateIfAvailable();
        if (!isBiometricAuthSuccessful) {
            Dialog.alert({ message: ErrorMessages.BIOMETRIC_AUTH });
            return;
        }

        const updatedServer = Object.assign({}, s, { port: Number(s.port) || 22 });
        const originalID = { host: this.state.originalHost, username: this.state.originalUsername };

        try {
            await this.serverService.edit(originalID, updatedServer, {
                ignoreCredential: this.state.ignoreCredential,
            });
        } catch (error: unknown) {
            Dialog.alert({ message: error instanceof Error ? error.message : ErrorMessages.SERVER_SAVE });
            return;
        }

        window.history.back();
    }

    onCancelClick(): void {
        window.history.back();
    }
}
