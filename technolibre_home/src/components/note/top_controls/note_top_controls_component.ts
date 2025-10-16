import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";

import AddIcon from "../../../assets/icon/add-plus-square-svgrepo-com.svg";
import AddDateIcon from "../../../assets/icon/date_edit.svg";
import AudioIcon from "../../../assets/icon/audio.svg";
import GlobeLocationIcon from "../../../assets/icon/globe_location.svg";
import TextIcon from "../../../assets/icon/text-selection-svgrepo-com.svg";

export class NoteTopControlsComponent extends EnhancedComponent {
	static template = xml`
		<div id="note__top-controls__wrapper">
			<section id="note__top-controls">
				<a
					id="note__control__location"
					class="note__control"
					href="#"
					t-on-click.stop.prevent="props.addLocation"
				>
					<img src="${AddIcon}" />
					<img src="${GlobeLocationIcon}" />
				</a>
				<a
					id="note__control__audio"
					class="note__control"
					href="#"
					t-on-click.stop.prevent="props.addAudio"
				>
					<img src="${AddIcon}" />
					<img src="${AudioIcon}" />
				</a>
				<a
					id="note__control__text"
					class="note__control"
					href="#"
					t-on-click.stop.prevent="props.addText"
				>
					<img src="${AddIcon}" />
					<img src="${TextIcon}" />
				</a>
				<a
					id="note__control__date"
					class="note__control"
					href="#"
					t-on-click.stop.prevent="props.addDateEntry"
				>
					<img src="${AddIcon}" />
					<img src="${AddDateIcon}" />
				</a>
			</section>
		</div>
	`;
}
