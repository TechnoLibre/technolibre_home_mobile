import { Component, useState, xml } from "@odoo/owl";

import { ToolBarType } from "@capgo/inappbrowser";

import { WebViewUtils } from "../../utils/webViewUtils";

import TechnolibreLogo from "../../assets/technolibre_logo.png";

export class HomeComponent extends Component {
	static template = xml`
    <div id="home-component">
      <div id="centered-content">
        <img id="logo" src="${TechnolibreLogo}" alt="Logo TechnoLibre" />
        <h3 id="title">TECHNOLIBRE</h3>
        <section id="buttons">
          <button id="openWebsite" class="buttons-primary" t-on-click="onOpenWebsiteClick">Connexion</button>
        </section>
      </div>
    </div>
  `;

	state: any = undefined;

	setup() {
		this.state = useState({ title: "HomeComponent", isDev: false });
	}

	onOpenWebsiteClick() {
		if (WebViewUtils.isMobile()) {
			WebViewUtils.openWebViewMobile({
				url: this.getWebsiteURL(),
				title: "technolibre.ca",
				showReloadButton: true,
				toolbarType: ToolBarType.NAVIGATION
			});
		} else {
			WebViewUtils.openWebViewDesktop(this.getWebsiteURL());
		}
	}

	getWebsiteURL() {
		if (this.state.isDev) {
			return "https://technolibre.ca/web/login";
		}
		return "https://technolibre.ca/web/login";
	}
}
