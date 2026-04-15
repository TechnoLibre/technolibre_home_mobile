import { onError, useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { Events } from "../../constants/events";

export class ContentComponent extends EnhancedComponent {
	static template = xml`
		<div id="content-component">
			<section id="content">
				<t t-if="state.hasError">
					<div class="content-error">
						<p class="content-error__msg" t-esc="t('message.component_error')"/>
						<button class="content-error__home" t-on-click="onGoHomeClick"
						        t-esc="t('button.go_home')"/>
					</div>
				</t>
				<t t-else="">
					<t t-component="getRouteComponent()" t-key="state.currentRoute" />
				</t>
			</section>
		</div>
	`;

	setup() {
		this.state = useState({ currentRoute: window.location.pathname, params: {}, hasError: false });
		this.listenForEvents();
		onError((error) => {
			console.error("[ContentComponent] Child component error:", error);
			this.state.hasError = true;
		});
	}

	onGoHomeClick() {
		this.state.hasError = false;
		this.navigate("/");
	}

	getRouteComponent() {
		const getComponentResult = this.router.getComponent(this.state.currentRoute);
		return getComponentResult.component;
	}

	private listenForEvents() {
		this.eventBus.addEventListener(Events.ROUTER_NAVIGATION, () => {
			this.state.hasError = false;
			this._resetScroll();
			this.state.currentRoute = window.location.pathname;
		});

		window.addEventListener("popstate", () => {
			this.state.hasError = false;
			this._resetScroll();
			this.state.currentRoute = window.location.pathname;
		});
	}

	private _resetScroll() {
		const el = document.getElementById("content-component");
		if (el) el.scrollTop = 0;
	}
}
