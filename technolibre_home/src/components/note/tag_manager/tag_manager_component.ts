import { onMounted, useRef, useState, xml } from "@odoo/owl";

import { Constants } from "../../../js/constants";
import { EnhancedComponent } from "../../../js/enhancedComponent";

export class TagManagerComponent extends EnhancedComponent {
	static template = xml`
		<div
			id="tag-manager__popover"
			popover=""
			t-ref="tag-manager-popover"
			t-on-click.stop.prevent="hidePopover"
		>
			<div id="tag-manager__wrapper" t-on-click.stop.prevent="">
				<div id="tag-manager">
					<section id="tag-manager__heading">
						<h3>Tag Manager</h3>
					</section>
					<section id="tag-manager__top-controls">
						<form
							id="tag-manager__form"
							t-on-input.stop.prevent="onSearchInput"
						>
							<input
								id="tag-manager__search"
								type="text"
								placeholder="Rechercher"
								t-model="state.search"
							/>
						</form>
					</section>
					<section id="tag-manager__content">
						<ul
							id="tag-manager__applied"
							class="tag-manager__tag-list"
						>
							<li class="tag-manager__tag-list__item">Applied Tag</li>
						</ul>
						<ul
							id="tag-manager__unapplied"
							class="tag-manager__tag-list"
						>
							<li class="tag-manager__tag-list__item">Unapplied Tag</li>
						</ul>
					</section>
					<section id="tag-manager__bottom-controls">
						<a
							id="tag-manager__create"
							class="tag-manager__action"
							href="#"
							t-att-class="{
								'disabled': isCreateDisabled()
							}"
							t-on-click.stop.prevent="onCreateTagClick"
						>
							Create
						</a>
						<a
							id="tag-manager__close"
							class="tag-manager__action"
							href="#"
							t-on-click.stop.prevent="hidePopover"
						>
							Close
						</a>
					</section>
				</div>
			</div>
		</div>
	`;

	tagManagerPopover = useRef("tag-manager-popover");

	setup() {
		this.state = useState({ search: "", tags: new Array<string>() });
		onMounted(() => {
			this.eventBus.addEventListener(Constants.TAG_MANAGER_EVENT_NAME, this.showPopover.bind(this));
		});
	}

	showPopover() {
		if (!this.tagManagerPopover.el) {
			return;
		}

		this.state.search = "";
		this.tagManagerPopover.el.showPopover();
	}

	hidePopover() {
		if (!this.tagManagerPopover.el) {
			return;
		}

		this.state.search = "";
		this.tagManagerPopover.el.hidePopover();
	}

	onSearchInput() {
		console.log(this.state.search);
	}

	onCreateTagClick() {
		console.log("onCreateTagClick()");
	}

	isCreateDisabled(): boolean {
		return this.state.search === "";
	}
}
