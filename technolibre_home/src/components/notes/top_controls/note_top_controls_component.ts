import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";

import AudioIcon from "../../../assets/icon/audio.svg";
import EditNoteIcon from "../../../assets/icon/edit_note.svg";
import TextIcon from "../../../assets/icon/text.svg";

export class NoteTopControlsComponent extends EnhancedComponent {
	static template = xml`
		<div id="note__top-controls__wrapper">
			<section id="note__top-controls">
				<a
					id="note__control__audio"
					class="note__control"
					href="#"
					t-on-click.stop.prevent="props.addAudio"
				>
					<img src="${AudioIcon}" />
					<p class="greyed-out">Add Audio</p>
				</a>
				<a
					id="note__control__text"
					class="note__control"
					href="#"
					t-on-click.stop.prevent="props.addText"
				>
					<img src="${TextIcon}" />
					<p>Add Text</p>
				</a>
				<a
					id="note__control__edit"
					class="note__control"
					href="#"
					t-on-click.stop.prevent="props.toggleEditMode"
				>
					<img src="${EditNoteIcon}" />
					<p>Edit Mode</p>
				</a>
			</section>
		</div>
	`;
}
