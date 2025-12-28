import { useRef, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { Events } from "../../../constants/events";

import { helpers } from "../../../js/helpers";

export class NoteEntryGeolocationComponent extends EnhancedComponent {
	static template = xml`
		<button
			type="button"
			class="geolocation__open-popover"
			t-on-click.stop.prevent="showPopover"
		>
			<t t-esc="props.params.text"></t>
		</button>
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

	geolocationPopover = useRef("geolocation-popover");

	setup() {
		this.eventBus.addEventListener(Events.GEOLOCATION, this.showPopover.bind(this));
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
		return helpers.formatDate(timestamp);
	}
}
