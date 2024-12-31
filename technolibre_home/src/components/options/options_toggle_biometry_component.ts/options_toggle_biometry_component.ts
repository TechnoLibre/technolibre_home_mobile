import { Component, useState, xml } from "@odoo/owl";

import { ConfirmResult, Dialog } from "@capacitor/dialog";

import { BiometryUtils } from "../../../utils/biometryUtils";
import { Constants } from "../../../js/constants";
import { StorageGetResult, StorageUtils } from "../../../utils/storageUtils";

export class OptionsToggleBiometryComponent extends Component {
	static template = xml`
    <li class="options-list__item" t-if="state.isBiometryActivated">
      <a
        href="#"
        t-on-click.stop.prevent="onEnableBiometryClick"
        t-if="state.hasUserEnabledBiometry === false"
      >
        Activer biométrie
      </a>
      <a
        href="#"
        t-on-click.stop.prevent="onDisableBiometryClick"
        t-if="state.hasUserEnabledBiometry === true"
      >
        Désactiver biométrie
      </a>
    </li>
  `;

	state: any = undefined;

	async setup() {
		this.state = useState({
			isBiometryActivated: undefined,
			hasUserEnabledBiometry: undefined
		});

		this.state.isBiometryActivated = await BiometryUtils.isBiometryAvailable();
		this.state.hasUserEnabledBiometry = await this.checkHasUserEnabledBiometry();
	}

	async onEnableBiometryClick() {
		this.toggleBiometry(
			"Activer la biométrie?",
			"Cette application utilise l'authentification biométrique pour s'assurer que vous seul ayez accès aux informations sécurisées.",
			"Succès",
			"L'authentification biométrique a été activée avec succès.",
			"Erreur",
			"Échec de l'authentification biométrique.",
			true
		);
	}

	async onDisableBiometryClick() {
		this.toggleBiometry(
			"Désactiver la biométrie?",
			"Cette application utilise l'authentification biométrique pour s'assurer que vous seul ayez accès aux informations sécurisées.",
			"Succès",
			"L'authentification biométrique a été désactivée avec succès.",
			"Erreur",
			"Échec de l'authentification biométrique.",
			false
		);
	}

	private async toggleBiometry(
		confirmTitle: string,
		confirmMessage: string,
		successTitle: string,
		successMessage: string,
		failureTitle: string,
		failureMessage: string,
		newIsBiometryEnabledValue: boolean
	) {
		const confirmResult: ConfirmResult = await Dialog.confirm({
			message: confirmMessage,
			title: confirmTitle
		});

		if (!confirmResult.value) {
			return;
		}

		const isBiometricAuthSuccessful: boolean = await BiometryUtils.authenticate({
			message: failureMessage,
			title: failureTitle
		});

		if (!isBiometricAuthSuccessful) {
			return;
		}

		await StorageUtils.setKeyValuePair(Constants.BIOMETRY_ENABLED_STORAGE_KEY, newIsBiometryEnabledValue);

		this.state.hasUserEnabledBiometry = await this.checkHasUserEnabledBiometry();

		Dialog.alert({
			message: successMessage,
			title: successTitle
		});
	}

	private async checkHasUserEnabledBiometry(): Promise<boolean> {
		const result: StorageGetResult = await StorageUtils.getValueByKey<boolean>(Constants.BIOMETRY_ENABLED_STORAGE_KEY);

		return result.isValid && result.value;
	}
}
