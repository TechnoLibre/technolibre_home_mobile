import { useRef, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../../js/enhancedComponent";

import { NoteEntryDragComponent } from "../drag/note_entry_drag_component";
import { Constants } from "../../../../js/constants";

export class NoteEntryGeolocationComponent extends EnhancedComponent {
	static template = xml`
		<div
			class="note-entry-component note-entry-geolocation-component"
			t-att-data-id="props.id"
		>
			<NoteEntryDragComponent editMode="props.editMode" />
			<div class="note-entry__content">
				<button
					type="button"
					class="geolocation__open-popover"
					t-on-click.stop.prevent="showPopover"
				>
					<t t-esc="props.params.text"></t>
				</button>
			</div>
		</div>
		<div
			class="geolocation-popover"
			popover=""
			t-ref="geolocation-popover"
			t-on-click.stop.prevent="hidePopover"
		>
			<div class="geolocation-display__wrapper" t-on-click.stop.prevent="">
				<div class="geolocation-display">
					<h1>
						Geolocation information
					</h1>
				</div>
			</div>
		</div>
	`;

	static components = { NoteEntryDragComponent };

	geolocationPopover = useRef("geolocation-popover");

	setup() {
		this.eventBus.addEventListener(Constants.GEOLOCATION_EVENT_NAME, this.showPopover.bind(this));
	}

	showPopover() {
		if (!this.geolocationPopover.el) {
			return;
		}

		this.geolocationPopover.el.showPopover();
	}

	hidePopover() {
		if (!this.geolocationPopover.el) {
			return;
		}

		this.geolocationPopover.el.hidePopover();
	}
}
