import { useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { Events } from "../../constants/events";
import { WebViewUtils } from "../../utils/webViewUtils";

// @ts-ignore
import CompanyLogo from "../../assets/company_logo.png";

const ENV = {
    // @ts-ignore
  TITLE: import.meta.env.VITE_TITLE ?? "TITLE",
    // @ts-ignore
  BUTTON_LABEL: import.meta.env.VITE_BUTTON_LABEL ?? "Connexion",
    // @ts-ignore
  LOGO_KEY: import.meta.env.VITE_LOGO_KEY ?? "techno",
    // @ts-ignore
  WEBSITE_URL: import.meta.env.VITE_WEBSITE_URL ?? "https://erplibre.ca",
};

export class HomeComponent extends EnhancedComponent {
	static template = xml`
    <div id="home-component">
      <div id="centered-content">
        <img id="logo" src="${CompanyLogo}" alt="Logo TechnoLibre" t-on-click="onOpenSocietyClick"/>
        <h3 id="title" t-esc="state.title" t-on-click="onOpenSocietyClick" />
        <section id="buttons">
          <button id="notes" class="buttons-primary" t-on-click.stop.prevent="onNotesClick">Notes</button>
        </section>
      </div>
    </div>
  `;

	setup() {
		this.state = useState({ title: ENV.TITLE, isDev: false  });
	}

	onOpenSocietyClick() {
		if (WebViewUtils.isMobile()) {
			WebViewUtils.openWebViewMobile({
				url: this.getWebsiteURL(),
				title: ENV.WEBSITE_URL,
				isPresentAfterPageLoad: true,
				enabledSafeBottomMargin: true,
				useTopInset: true,
				activeNativeNavigationForWebview: true,
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

	onNotesClick() {
		this.eventBus.trigger(Events.ROUTER_NAVIGATION, { url: "/notes" });
	}
}
