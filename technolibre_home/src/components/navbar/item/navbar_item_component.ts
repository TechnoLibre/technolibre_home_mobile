import { Component, onMounted, onWillUnmount, useRef, useState, xml } from "@odoo/owl";

import { SimpleRouter } from "../../../js/router";

export class NavbarItemComponent extends Component {
	static template = xml`
		<li
			class="nav-list__item"
			t-att-class="{
				'active': props.currentRoute === props.path,
				'active-subpath': this.subpathMatches(),
				'held': state.isHeld
			}"
			t-ref="li"
			t-on-click.stop.prevent="() => props.onItemClick(props.path)"
		>
			<p class="nav-list__item__text"><t t-esc="props.displayName"></t></p>
		</li>
	`;

	state: any = {};

	li = useRef("li");

	setup() {
		this.state = useState({ timer: undefined, isHeld: false, timeoutDuration: 75 });

		onMounted(() => {
			if (this.li.el) {
				this.li.el.addEventListener("touchstart", this.onTouchStart.bind(this), { passive: true });
				this.li.el.addEventListener("touchend", this.onTouchEnd.bind(this), { passive: true });
				this.li.el.addEventListener("touchcancel", this.onTouchCancel.bind(this), { passive: true });
			}
		});

		onWillUnmount(() => {
			if (this.li.el) {
				this.li.el.removeEventListener("touchstart", this.onTouchStart.bind(this));
				this.li.el.removeEventListener("touchend", this.onTouchEnd.bind(this));
				this.li.el.removeEventListener("touchcancel", this.onTouchCancel.bind(this));
			}
		});
	}

	onTouchStart() {
		this.state.timer = setTimeout(() => (this.state.isHeld = true), this.state.timeoutDuration);
	}

	onTouchEnd() {
		clearTimeout(this.state.timer);
		this.state.isHeld = false;
	}

	onTouchCancel() {
		clearTimeout(this.state.timer);
		this.state.isHeld = false;
	}

	subpathMatches(): boolean {
		const router: SimpleRouter = this.env.router;

		for (let subpath of this.props.subpaths) {
			if (router.doRoutesMatch(this.props.currentRoute, subpath)) {
				return true;
			}
		}

		return false;
	}
}
