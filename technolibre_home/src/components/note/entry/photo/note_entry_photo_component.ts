import { useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../../js/enhancedComponent";
import { NoteEntryDragComponent } from "../drag/note_entry_drag_component";
import { NoteEntryDeleteComponent } from "../delete/note_entry_delete_component";

import PhotoOffIcon from "../../../../assets/icon/photo_off.svg";

export class NoteEntryPhotoComponent extends EnhancedComponent {
	static template = xml`
		<div
			class="note-entry-component note-entry-photo-component"
			t-att-data-id="props.id"
			t-att-class="{
				'not-empty': props.params.path
			}"
		>
			<NoteEntryDeleteComponent id="props.id" editMode="props.editMode" deleteEntry.bind="props.deleteEntry" />
			<div
				class="note-entry__content"
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
			<NoteEntryDragComponent editMode="props.editMode" />
		</div>
	`;

	static components = { NoteEntryDragComponent, NoteEntryDeleteComponent };

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}
