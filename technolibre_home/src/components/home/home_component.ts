import { Component, useState, xml } from "@odoo/owl";

import { ToolBarType } from "@capgo/inappbrowser";

import { WebViewUtils } from "../../utils/webViewUtils";

import CompanyLogo from "../../assets/company_logo.png";

const ENV = {
  TITLE: import.meta.env.VITE_TITLE ?? "TITLE",
  BUTTON_LABEL: import.meta.env.VITE_BUTTON_LABEL ?? "Connexion",
  LOGO_KEY: import.meta.env.VITE_LOGO_KEY ?? "techno",
  WEBSITE_URL: import.meta.env.VITE_WEBSITE_URL ?? "https://erplibre.ca",
};

export class HomeComponent extends Component {
	static template = xml`
    <div id="home-component">
      <div id="centered-content">
        <img id="logo" src="${CompanyLogo}" alt="Logo TechnoLibre" />
        <h3 id="title" t-esc="state.title" />
        <section id="buttons">
          <button id="openWebsite" class="buttons-primary" t-on-click="onOpenWebsiteClick">Connexion</button>
        </section>
      </div>
    </div>
  `;

	state: any = undefined;

	setup() {
		this.state = useState({ title: ENV.TITLE, isDev: false  });
	}

	onOpenWebsiteClick() {
		if (WebViewUtils.isMobile()) {
			WebViewUtils.openWebViewMobile({
				url: this.getWebsiteURL(),
				title: ENV.WEBSITE_URL,
				showReloadButton: true,
				toolbarType: ToolBarType.NAVIGATION
			});
		} else {
			WebViewUtils.openWebViewDesktop(this.getWebsiteURL());
		}
	}

	getWebsiteURL() {
        return ENV.WEBSITE_URL;
		// if (this.state.isDev) {
		// 	return "https://technolibre.ca/web/login";
		// }
		// return "https://technolibre.ca/web/login";
	}
}
