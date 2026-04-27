import { xml } from "@odoo/owl";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { HeadingComponent } from "../../heading/heading_component";
import { WebViewUtils } from "../../../utils/webViewUtils";

// @ts-ignore
import CompanyLogo from "../../../assets/company_logo.png";

// @ts-ignore
const WEBSITE_URL: string = import.meta.env.VITE_WEBSITE_URL ?? "https://erplibre.ca";

export class OptionsErplibreComponent extends EnhancedComponent {
    // Module-level constants exposed to the static template so the xml`...`
    // literal stays interpolation-free and AOT-precompilable.
    companyLogo = CompanyLogo;

	static template = xml`
      <div id="options-erplibre-component">
        <HeadingComponent title="'ERPLibre'" breadcrumbs="breadcrumbs" />
        <div class="erplibre__content">
          <img class="erplibre__logo" t-att-src="companyLogo" alt="Logo ERPLibre" />
          <h2 class="erplibre__title">ERPLibre</h2>
          <p class="erplibre__tagline">Logiciel de gestion d'entreprise</p>
          <p class="erplibre__description">
            ERPLibre est une plateforme ERP communautaire libre, basée sur
            Odoo Community Edition. Elle vous permet de gérer vos ventes,
            achats, comptabilité, ressources humaines et bien plus, en toute
            autonomie.
          </p>
          <p class="erplibre__description">
            Libre, modulaire et souverain — ERPLibre est conçu pour les
            entreprises qui souhaitent garder le contrôle de leurs données.
          </p>
          <button class="erplibre__btn-website" t-on-click="onOpenWebsiteClick">
            Ouvrir le site web
          </button>
        </div>
      </div>
    `;

	static components = { HeadingComponent };

	get breadcrumbs() {
		return [{ label: "Options", url: "/options" }];
	}

	onOpenWebsiteClick() {
		if (WebViewUtils.isMobile()) {
			WebViewUtils.openWebViewMobile({
				url: WEBSITE_URL,
				title: WEBSITE_URL,
				isPresentAfterPageLoad: true,
				preShowScript: WebViewUtils.safeAreaScript(),
				enabledSafeBottomMargin: true,
				toolbarColor: "#1a1a1a",
				toolbarTextColor: "#ffffff",
				activeNativeNavigationForWebview: true,
			});
		} else {
			WebViewUtils.openWebViewDesktop(WEBSITE_URL);
		}
	}
}
