import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";

import AddDateIcon from "../../../assets/icon/date_edit.svg";
import AddPhotoIcon from "../../../assets/icon/photo.svg";
import AddVideoIcon from "../../../assets/icon/video_add.svg";
import AudioIcon from "../../../assets/icon/audio.svg";
import GlobeLocationIcon from "../../../assets/icon/globe_location.svg";
import TextIcon from "../../../assets/icon/text-selection-svgrepo-com.svg";

export class NoteBottomControlsComponent extends EnhancedComponent {
    // Module-level constants exposed to the static template so the xml`...`
    // literal stays interpolation-free and AOT-precompilable.
    globeLocationIcon = GlobeLocationIcon;
    addPhotoIcon = AddPhotoIcon;
    addVideoIcon = AddVideoIcon;
    audioIcon = AudioIcon;
    textIcon = TextIcon;
    addDateIcon = AddDateIcon;

	static template = xml`
<div id="note__bottom-controls__wrapper">
	<section id="note__bottom-controls">
		<a
			id="note__control__location"
			class="note__control"
			href="#"
			role="button"
			aria-label="Ajouter un lieu"
			t-on-click.stop.prevent="props.addLocation"
		>
			<img t-att-src="globeLocationIcon" alt="" aria-hidden="true"/>
			<span>Lieu</span>
		</a>
		<a
			id="note__control__photo"
			class="note__control"
			href="#"
			role="button"
			aria-label="Ajouter une photo"
			t-on-click.stop.prevent="props.addPhoto"
		>
			<img t-att-src="addPhotoIcon" alt="" aria-hidden="true"/>
			<span>Photo</span>
		</a>
		<a
			id="note__control__video"
			class="note__control"
			href="#"
			role="button"
			aria-label="Ajouter une vidéo"
			t-on-click.stop.prevent="props.addVideo"
		>
			<img t-att-src="addVideoIcon" alt="" aria-hidden="true"/>
			<span>Vidéo</span>
		</a>
		<a
			id="note__control__audio"
			class="note__control"
			href="#"
			role="button"
			aria-label="Ajouter un audio"
			t-on-click.stop.prevent="props.addAudio"
		>
			<img t-att-src="audioIcon" alt="" aria-hidden="true"/>
			<span>Audio</span>
		</a>
		<a
			id="note__control__text"
			class="note__control"
			href="#"
			role="button"
			aria-label="Ajouter du texte"
			t-on-click.stop.prevent="props.addText"
		>
			<img t-att-src="textIcon" alt="" aria-hidden="true"/>
			<span>Texte</span>
		</a>
		<a
			id="note__control__date"
			class="note__control"
			href="#"
			role="button"
			aria-label="Ajouter une date"
			t-on-click.stop.prevent="props.addDateEntry"
		>
			<img t-att-src="addDateIcon" alt="" aria-hidden="true"/>
			<span>Date</span>
		</a>
	</section>
</div>
	`;
}
