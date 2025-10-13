import { useRef, xml } from "@odoo/owl";

import { Constants } from "../../../../js/constants";
import { EnhancedComponent } from "../../../../js/enhancedComponent";

import { NoteEntryDeleteComponent } from "../delete/note_entry_delete_component";
import { NoteEntryDragComponent } from "../drag/note_entry_drag_component";

export class NoteEntryGeolocationComponent extends EnhancedComponent {
	static template = xml`
		<div
			class="note-entry-component note-entry-geolocation-component"
			t-att-data-id="props.id"
		>
			<NoteEntryDeleteComponent id="props.id" editMode="props.editMode" deleteEntry.bind="props.deleteEntry" />
			<div class="note-entry__content">
				<button
					type="button"
					class="geolocation__open-popover"
					t-on-click.stop.prevent="showPopover"
				>
					<t t-esc="props.params.text"></t>
				</button>
			</div>
			<NoteEntryDragComponent editMode="props.editMode" />
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

	static components = { NoteEntryDeleteComponent, NoteEntryDragComponent };

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
