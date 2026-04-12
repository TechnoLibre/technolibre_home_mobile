import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";

import AddDateIcon from "../../../assets/icon/date_edit.svg";
import AddPhotoIcon from "../../../assets/icon/photo.svg";
import AddVideoIcon from "../../../assets/icon/video_add.svg";
import AudioIcon from "../../../assets/icon/audio.svg";
import GlobeLocationIcon from "../../../assets/icon/globe_location.svg";
import TextIcon from "../../../assets/icon/text-selection-svgrepo-com.svg";

export class NoteBottomControlsComponent extends EnhancedComponent {
	static template = xml`
<div id="note__bottom-controls__wrapper">
	<section id="note__bottom-controls">
		<a
			id="note__control__location"
			class="note__control"
			href="#"
			aria-label="Ajouter un lieu"
			t-on-click.stop.prevent="props.addLocation"
		>
			<img src="${GlobeLocationIcon}" alt="" aria-hidden="true"/>
			<span>Lieu</span>
		</a>
		<a
			id="note__control__photo"
			class="note__control"
			href="#"
			aria-label="Ajouter une photo"
			t-on-click.stop.prevent="props.addPhoto"
		>
			<img src="${AddPhotoIcon}" alt="" aria-hidden="true"/>
			<span>Photo</span>
		</a>
		<a
			id="note__control__video"
			class="note__control"
			href="#"
			aria-label="Ajouter une vidéo"
			t-on-click.stop.prevent="props.addVideo"
		>
			<img src="${AddVideoIcon}" alt="" aria-hidden="true"/>
			<span>Vidéo</span>
		</a>
		<a
			id="note__control__audio"
			class="note__control"
			href="#"
			aria-label="Ajouter un audio"
			t-on-click.stop.prevent="props.addAudio"
		>
			<img src="${AudioIcon}" alt="" aria-hidden="true"/>
			<span>Audio</span>
		</a>
		<a
			id="note__control__text"
			class="note__control"
			href="#"
			aria-label="Ajouter du texte"
			t-on-click.stop.prevent="props.addText"
		>
			<img src="${TextIcon}" alt="" aria-hidden="true"/>
			<span>Texte</span>
		</a>
		<a
			id="note__control__date"
			class="note__control"
			href="#"
			aria-label="Ajouter une date"
			t-on-click.stop.prevent="props.addDateEntry"
		>
			<img src="${AddDateIcon}" alt="" aria-hidden="true"/>
			<span>Date</span>
		</a>
	</section>
</div>
	`;
}
