import { Component, useState, xml } from "@odoo/owl";

import { Constants } from "../../js/constants";
import { SimpleRouter } from "../../js/router";

export class ContentComponent extends Component {
	static template = xml`
        <div id="content-component">
            <section id="content">
                <t t-component="getRouteComponent()" />
            </section>
        </div>
    `;

	state: any = undefined;

	setup() {
		this.state = useState({ currentRoute: window.location.pathname, params: {} });
		this.listenForEvents();
	}

	getRouteComponent() {
		const router: SimpleRouter = this.env.router;
		const getComponentResult = router.getComponent(this.state.currentRoute);
		return getComponentResult.component;
	}

	private listenForEvents() {
		this.env.eventBus.addEventListener(Constants.ROUTER_NAVIGATION_EVENT_NAME, () => {
			this.state.currentRoute = window.location.pathname;
		});

		window.addEventListener("popstate", () => {
			this.state.currentRoute = window.location.pathname;
		});
	}
}
