import { useState, xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";

import { BiometryUtils } from "../../../utils/biometryUtils";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { ErrorMessages } from "../../../constants/errorMessages";
import { HeadingComponent } from "../../heading/heading_component";

export class ServersAddComponent extends EnhancedComponent {
    static template = xml`
      <div id="servers-add-component">
        <HeadingComponent title="t('heading.add_server')"
          breadcrumbs="[{label: 'Applications', url: '/applications'}]" />
        <form id="server-add__form" t-on-submit="event => this.onSubmit(event)">

          <div class="server-add__form-group">
            <label for="server-add__label"><t t-esc="t('label.server_name_optional')"/></label>
            <input type="text" id="server-add__label" autocomplete="off"
                   t-att-placeholder="t('placeholder.server_example')" t-model="state.server.label" />
          </div>

          <div class="server-add__form-group">
            <label for="server-add__host"><t t-esc="t('label.ssh_host')"/></label>
            <input type="text" id="server-add__host" autocomplete="off" autocapitalize="off"
                   t-att-placeholder="t('placeholder.host_example')" required="true"
                   t-model="state.server.host" />
          </div>

          <div class="server-add__form-group">
            <label for="server-add__port"><t t-esc="t('label.ssh_port')"/></label>
            <input type="number" id="server-add__port" min="1" max="65535"
                   placeholder="22" t-model="state.server.port" />
          </div>

          <div class="server-add__form-group">
            <label for="server-add__username"><t t-esc="t('label.ssh_username')"/></label>
            <input type="text" id="server-add__username" autocomplete="off" autocapitalize="off"
                   t-att-placeholder="t('placeholder.user_example')" required="true"
                   t-model="state.server.username" />
          </div>

          <div class="server-add__form-group">
            <label for="server-add__deploy-path"><t t-esc="t('label.deploy_path')"/></label>
            <input type="text" id="server-add__deploy-path" autocomplete="off" autocapitalize="off"
                   placeholder="~/erplibre" t-model="state.server.deployPath" />
          </div>

          <div class="server-add__form-group">
            <label><t t-esc="t('label.auth_type')"/></label>
            <div class="server-add__auth-type">
              <label class="server-add__radio-label">
                <input type="radio" name="authType" value="password"
                       t-att-checked="state.server.authType === 'password'"
                       t-on-change="() => this.onAuthTypeChange('password')" />
                Mot de passe
              </label>
              <label class="server-add__radio-label">
                <input type="radio" name="authType" value="key"
                       t-att-checked="state.server.authType === 'key'"
                       t-on-change="() => this.onAuthTypeChange('key')" />
                Clé privée SSH
              </label>
            </div>
          </div>

          <t t-if="state.server.authType === 'password'">
            <div class="server-add__form-group">
              <label for="server-add__password"><t t-esc="t('label.ssh_password')"/></label>
              <input type="password" id="server-add__password" autocomplete="off"
                     t-att-placeholder="t('placeholder.password')" required="true"
                     t-model="state.server.password" />
            </div>
          </t>

          <t t-if="state.server.authType === 'key'">
            <div class="server-add__form-group">
              <label for="server-add__private-key"><t t-esc="t('label.private_key_pem')"/></label>
              <textarea id="server-add__private-key" rows="6"
                        placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;...&#10;-----END RSA PRIVATE KEY-----"
                        t-model="state.server.privateKey" />
            </div>
            <div class="server-add__form-group">
              <label for="server-add__passphrase"><t t-esc="t('label.passphrase_optional')"/></label>
              <input type="password" id="server-add__passphrase" autocomplete="off"
                     t-att-placeholder="t('placeholder.key_passphrase')"
                     t-model="state.server.passphrase" />
            </div>
          </t>

          <div class="server-add__form-group server-add__form-actions">
            <input type="submit" id="server-add__submit" value="Ajouter" />
            <button type="button" id="server-add__cancel" t-on-click="onCancelClick"><t t-esc="t('button.cancel')"/></button>
          </div>

        </form>
      </div>
    `;

    static components = { HeadingComponent };

    setup() {
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
        });
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

        if (s.authType === "password" && !s.password) {
            Dialog.alert({ message: ErrorMessages.EMPTY_FIELDS });
            return;
        }

        if (s.authType === "key" && !s.privateKey) {
            Dialog.alert({ message: ErrorMessages.EMPTY_FIELDS });
            return;
        }

        const isBiometricAuthSuccessful = await BiometryUtils.authenticateIfAvailable();
        if (!isBiometricAuthSuccessful) {
            Dialog.alert({ message: ErrorMessages.BIOMETRIC_AUTH });
            return;
        }

        const newServer = Object.assign({}, s, { port: Number(s.port) || 22 });

        try {
            await this.serverService.add(newServer);
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
