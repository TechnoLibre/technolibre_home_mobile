import { useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { Events } from "../../constants/events";

export class ContentComponent extends EnhancedComponent {
	static template = xml`
		<div id="content-component">
			<section id="content">
				<t t-component="getRouteComponent()" t-key="state.currentRoute" />
			</section>
		</div>
	`;

	setup() {
		this.state = useState({ currentRoute: window.location.pathname, params: {} });
		this.listenForEvents();
	}

	getRouteComponent() {
		const getComponentResult = this.router.getComponent(this.state.currentRoute);
		return getComponentResult.component;
	}

	private listenForEvents() {
		this.eventBus.addEventListener(Events.ROUTER_NAVIGATION, () => {
			this._resetScroll();
			this.state.currentRoute = window.location.pathname;
		});

		window.addEventListener("popstate", () => {
			this._resetScroll();
			this.state.currentRoute = window.location.pathname;
		});
	}

	private _resetScroll() {
		const el = document.getElementById("content-component");
		if (el) el.scrollTop = 0;
	}
}
