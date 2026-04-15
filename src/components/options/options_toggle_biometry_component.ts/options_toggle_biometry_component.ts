import { useState, xml } from "@odoo/owl";

import { ConfirmResult, Dialog } from "@capacitor/dialog";

import { BiometryUtils } from "../../../utils/biometryUtils";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { StorageConstants } from "../../../constants/storage";
import { StorageGetResult, StorageUtils } from "../../../utils/storageUtils";

export class OptionsToggleBiometryComponent extends EnhancedComponent {
	static template = xml`
    <li class="options-list__item" t-if="state.isBiometryActivated">
      <a
        href="#"
        t-on-click.stop.prevent="onEnableBiometryClick"
        t-if="state.hasUserEnabledBiometry === false"
        t-esc="t('button.enable_biometry')"
      />
      <a
        href="#"
        t-on-click.stop.prevent="onDisableBiometryClick"
        t-if="state.hasUserEnabledBiometry === true"
        t-esc="t('button.disable_biometry')"
      />
    </li>
  `;

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
			this.t("dialog.title.enable_biometry"),
			this.t("dialog.biometry_info"),
			this.t("label.success"),
			this.t("message.biometry_enabled"),
			this.t("label.error"),
			this.t("message.biometry_failed"),
			true
		);
	}

	async onDisableBiometryClick() {
		this.toggleBiometry(
			this.t("dialog.title.disable_biometry"),
			this.t("dialog.biometry_info"),
			this.t("label.success"),
			this.t("message.biometry_disabled"),
			this.t("label.error"),
			this.t("message.biometry_failed"),
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

		await StorageUtils.setKeyValuePair(StorageConstants.BIOMETRY_ENABLED_STORAGE_KEY, newIsBiometryEnabledValue);

		this.state.hasUserEnabledBiometry = await this.checkHasUserEnabledBiometry();

		Dialog.alert({
			message: successMessage,
			title: successTitle
		});
	}

	private async checkHasUserEnabledBiometry(): Promise<boolean> {
		const result: StorageGetResult = await StorageUtils.getValueByKey<boolean>(StorageConstants.BIOMETRY_ENABLED_STORAGE_KEY);

		return result.isValid && result.value;
	}
}
