import { onMounted, useRef, xml } from "@odoo/owl";

import { Constants } from "../../../js/constants";
import { EnhancedComponent } from "../../../js/enhancedComponent";

export class TagManagerComponent extends EnhancedComponent {
	static template = xml`
		<div
			id="tag-manager__popover"
			popover=""
			t-ref="tag-manager-popover"
			t-on-click.stop.prevent="onTagManagerPopoverClick"
		>
			<div id="tag-manager__wrapper" t-on-click.stop.prevent="">
				<div id="tag-manager">
					Tag Manager
				</div>
			</div>
		</div>
	`;

	tagManagerPopover = useRef("tag-manager-popover");

	setup() {
		onMounted(() => {
			this.eventBus.addEventListener(Constants.TAG_MANAGER_EVENT_NAME, this.showPopover.bind(this));
		});
	}

	showPopover() {
		if (!this.tagManagerPopover.el) {
			return;
		}

		this.tagManagerPopover.el.showPopover();
	}

	onTagManagerPopoverClick() {
		if (!this.tagManagerPopover.el) {
			return;
		}

		this.tagManagerPopover.el.hidePopover();
	}
}
