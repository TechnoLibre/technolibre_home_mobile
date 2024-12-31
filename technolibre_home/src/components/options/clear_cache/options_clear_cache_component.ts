import { Component, useState, xml } from "@odoo/owl";

import { ConfirmResult, Dialog } from "@capacitor/dialog";

import { WebViewUtils } from "../../../utils/webViewUtils";

export class OptionsClearCacheComponent extends Component {
	static template = xml`
    <li class="options-list__item">
      <a
        href="#"
        t-on-click.stop.prevent="onClearCacheClick"
      >
        Réinitialiser navigateur
      </a>
    </li>
  `;

	state: any = undefined;

	setup() {
		this.state = useState({});
	}

	async onClearCacheClick() {
		const confirmResult: ConfirmResult = await Dialog.confirm({
			message: "Voulez-vous réinitialiser le navigateur intégré?"
		});

		if (!confirmResult.value) {
			return;
		}

		await WebViewUtils.clearCache();

		Dialog.alert({
			message: "Navigateur intégré réinitialisé avec succès."
		});
	}
}
