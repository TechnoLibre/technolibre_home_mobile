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
					<section class="geolocation-display__heading">
						<h3>Données de géolocalisation</h3>
					</section>
					<section class="geolocation-display__content">
						<p>
							<b>Latitude:</b>&#160;<t t-esc="props.params.latitude"></t>
						</p>
						<p>
							<b>Longitude:</b>&#160;<t t-esc="props.params.longitude"></t>
						</p>
						<p>
							<b>Date:</b>&#160;<t t-esc="formatGeolocationTimestamp(props.params.timestamp)"></t>
						</p>
					</section>
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

	formatGeolocationTimestamp(timestamp: number) {
		return (new Date(timestamp)).toLocaleDateString("fr-CA", {
				day: "numeric",
				month: "long",
				year: "numeric",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
				hour12: false
			}
		);
	}
}
