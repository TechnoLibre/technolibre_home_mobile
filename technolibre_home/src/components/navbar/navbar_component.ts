import { Component, useState, xml } from "@odoo/owl";

import { Constants } from "../../js/constants";

import { NavbarItemComponent } from "./item/navbar_item_component";

export class NavbarComponent extends Component {
	static template = xml`
		<nav id="nav">
			<ul id="nav-list">
				<NavbarItemComponent
					displayName="'Accueil'"
					currentRoute="state.currentRoute"
					path="'/'"
					subpaths="[]"
					onItemClick.bind="onNavListItemClick"
				/>
				<NavbarItemComponent
					displayName="'Apps'"
					currentRoute="state.currentRoute"
					path="'/applications'"
					subpaths="['/applications/add', '/applications/edit/:url/:username']"
					onItemClick.bind="onNavListItemClick"
				/>
				<NavbarItemComponent
					displayName="'Options'"
					currentRoute="state.currentRoute"
					path="'/options'"
					subpaths="[]"
					onItemClick.bind="onNavListItemClick"
				/>
			</ul>
		</nav>
	`;

	static components = { NavbarItemComponent };

	state: any = undefined;

	setup() {
		this.state = useState({ currentRoute: window.location.pathname });

		this.env.eventBus.addEventListener(Constants.ROUTER_NAVIGATION_EVENT_NAME, () => {
			this.state.currentRoute = window.location.pathname;
		});

		window.addEventListener("popstate", () => {
			this.state.currentRoute = window.location.pathname;
		});
	}

	onNavListItemClick(path) {
		this.env.eventBus.trigger(Constants.ROUTER_NAVIGATION_EVENT_NAME, { url: path });
	}
}
