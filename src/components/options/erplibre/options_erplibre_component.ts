import { xml } from "@odoo/owl";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { HeadingComponent } from "../../heading/heading_component";
import { WebViewUtils } from "../../../utils/webViewUtils";

// @ts-ignore
import CompanyLogo from "../../../assets/company_logo.png";

// @ts-ignore
const WEBSITE_URL: string = import.meta.env.VITE_WEBSITE_URL ?? "https://erplibre.ca";

export class OptionsErplibreComponent extends EnhancedComponent {
	static template = xml`
      <div id="options-erplibre-component">
        <HeadingComponent title="'ERPLibre'" breadcrumbs="breadcrumbs" />
        <div class="erplibre__content">
          <img class="erplibre__logo" src="${CompanyLogo}" t-att-alt="t('aria.erplibre_logo')" />
          <h2 class="erplibre__title">ERPLibre</h2>
          <p class="erplibre__tagline" t-esc="t('erplibre.tagline')" />
          <p class="erplibre__description" t-esc="t('erplibre.description_1')" />
          <p class="erplibre__description" t-esc="t('erplibre.description_2')" />
          <button class="erplibre__btn-website" t-on-click="onOpenWebsiteClick" t-esc="t('button.open_website')" />
        </div>
      </div>
    `;

	static components = { HeadingComponent };

	get breadcrumbs() {
		return [{ label: this.t("breadcrumb.options"), url: "/options" }];
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
