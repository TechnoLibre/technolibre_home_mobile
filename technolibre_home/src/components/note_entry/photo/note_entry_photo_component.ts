import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";

import PhotoOffIcon from "../../../assets/icon/photo_off.svg";

export class NoteEntryPhotoComponent extends EnhancedComponent {
	static template = xml`
		<div
			class="note-entry__wrapper"
			t-att-class="{
				'not-empty': props.params.path
			}"
		>
			<div class="note-entry__photo__thumbnail__wrapper">
				<div
					class="note-entry__photo__thumbnail"
				>
					<img src="${PhotoOffIcon}" />
				</div>
			</div>
			<div class="note-entry__photo__data">
				<button
					class="note-entry__photo__button note-entry__photo__open-camera"
					t-on-click.stop.prevent="onClickOpenCamera"
				>
					Ouvrir la caméra
				</button>
				<button
					class="note-entry__photo__button note-entry__photo__open-photo"
					t-if="props.params.path"
					t-on-click.stop.prevent="onClickOpenVideo"
				>
					Ouvrir la photo
				</button>
			</div>
		</div>
	`;
}
