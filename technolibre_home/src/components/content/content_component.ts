import { useState, xml } from "@odoo/owl";

import { Constants } from "../../js/constants";
import { EnhancedComponent } from "../../js/enhancedComponent";

export class ContentComponent extends EnhancedComponent {
	static template = xml`
        <div id="content-component">
            <section id="content">
                <t t-component="getRouteComponent()" />
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
		this.eventBus.addEventListener(Constants.ROUTER_NAVIGATION_EVENT_NAME, () => {
			this.state.currentRoute = window.location.pathname;
		});

		window.addEventListener("popstate", () => {
			this.state.currentRoute = window.location.pathname;
		});
	}
}
