import { useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { Events } from "../../constants/events";

import { NavbarItemComponent } from "./item/navbar_item_component";

export class NavbarComponent extends EnhancedComponent {
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

	setup() {
		this.state = useState({ currentRoute: window.location.pathname });

		this.eventBus.addEventListener(Events.ROUTER_NAVIGATION, () => {
			this.state.currentRoute = window.location.pathname;
		});

		window.addEventListener("popstate", () => {
			this.state.currentRoute = window.location.pathname;
		});
	}

	onNavListItemClick(path) {
		this.eventBus.trigger(Events.ROUTER_NAVIGATION, { url: path });
	}
}
