import { onWillDestroy, useRef, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { Events } from "../../../constants/events";

import { helpers } from "../../../js/helpers";

export class NoteEntryGeolocationComponent extends EnhancedComponent {
	static template = xml`
		<button
			type="button"
			class="geolocation__open-popover"
			aria-label="Voir les données de géolocalisation"
			t-on-click.stop.prevent="showPopover"
		>
			<t t-esc="props.params.text"></t>
		</button>
		<div
			class="geolocation-popover"
			popover=""
			role="dialog"
			aria-modal="true"
			aria-labelledby="geolocation-display__title"
			t-ref="geolocation-popover"
			t-on-click.stop.prevent="hidePopover"
		>
			<div class="geolocation-display__wrapper" t-on-click.stop.prevent="">
				<div class="geolocation-display">
					<section class="geolocation-display__heading">
						<h2 id="geolocation-display__title">Données de géolocalisation</h2>
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
					<section class="geolocation-display__actions">
						<button
							type="button"
							class="geolocation-display__open-map"
							t-on-click.stop.prevent="openMap"
						>
							Ouvrir la carte
						</button>
					</section>
				</div>
			</div>
		</div>
	`;

	geolocationPopover = useRef("geolocation-popover");

	setup() {
		const onGeolocation = this.showPopover.bind(this);
		this.eventBus.addEventListener(Events.GEOLOCATION, onGeolocation);
		onWillDestroy(() => {
			this.eventBus.removeEventListener(Events.GEOLOCATION, onGeolocation);
		});
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

	openMap() {
		const { latitude, longitude } = this.props.params;
		window.open(`https://maps.google.com/?q=${latitude},${longitude}`, "_system");
	}

	formatGeolocationTimestamp(timestamp: number) {
		return helpers.formatDate(timestamp);
	}
}
