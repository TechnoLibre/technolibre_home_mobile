import { xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";

import { Server, ServerID } from "../../../models/server";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { BiometryUtils } from "../../../utils/biometryUtils";
import { ErrorMessages } from "../../../constants/errorMessages";
import { Events } from "../../../constants/events";

export class ServersItemComponent extends EnhancedComponent {
    static template = xml`
      <li class="servers-item">
        <div class="servers-item__info">
          <span class="servers-item__label" t-esc="props.server.label || props.server.host" />
          <span class="servers-item__address">
            <t t-esc="props.server.username" />@<t t-esc="props.server.host" />:<t t-esc="props.server.port" />
          </span>
          <span class="servers-item__path" t-esc="props.server.deployPath" />
        </div>
        <div class="servers-item__actions">
          <button class="servers-item__btn servers-item__btn--delete"
            t-on-click="() => this.onDeleteClick()">
            Supprimer
          </button>
          <button class="servers-item__btn servers-item__btn--edit"
            t-on-click="() => this.onEditClick()">
            Modifier
          </button>
          <button class="servers-item__btn servers-item__btn--deploy"
            t-on-click="() => this.onDeployClick()">
            Déployer
          </button>
        </div>
      </li>
    `;

    static props = {
        server: { type: Object },
        deleteServer: { type: Function },
        editServer: { type: Function },
    };

    onDeployClick(): void {
        const encodedHost = encodeURIComponent(this.props.server.host);
        const encodedUsername = encodeURIComponent(this.props.server.username);
        this.eventBus.trigger(Events.ROUTER_NAVIGATION, {
            url: `/servers/deploy/${encodedHost}/${encodedUsername}`,
        });
    }

    onEditClick(): void {
        this.props.editServer({ host: this.props.server.host, username: this.props.server.username } as ServerID);
    }

    async onDeleteClick(): Promise<void> {
        const serverID: ServerID = { host: this.props.server.host, username: this.props.server.username };
        const label = this.props.server.label || this.props.server.host;

        const confirmed = confirm(`Voulez-vous vraiment supprimer le serveur « ${label} » (${serverID.username}@${serverID.host}) ?`);
        if (!confirmed) return;

        const isBiometricAuthSuccessful = await BiometryUtils.authenticateIfAvailable();
        if (!isBiometricAuthSuccessful) {
            Dialog.alert({ message: ErrorMessages.BIOMETRIC_AUTH });
            return;
        }

        this.props.deleteServer(serverID);
    }
}
