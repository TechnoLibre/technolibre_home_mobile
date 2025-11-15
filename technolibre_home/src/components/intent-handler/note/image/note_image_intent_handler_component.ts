import { Capacitor } from "@capacitor/core";
import { useState, xml } from "@odoo/owl";
import { EnhancedComponent } from "../../../../js/enhancedComponent";
import { Events } from "../../../../constants/events";
import { ImageIntent } from "../../../../models/intent";

export class NoteImageIntentHandlerComponent extends EnhancedComponent {
	static template = xml`
		<div id="note-image-intent-handler-component">
			<h1 class="intent__title">Ajouter une image</h1>
			<img class="intent__thumbnail" t-att-src="state.imageUri" />
			<h3 class="intent__notes__title">Notes</h3>
			<ul class="intent__notes" t-if="state.notes.length !== 0">
				<li
					class="intent__item intent__item--new"
					t-on-click.stop.prevent="newNoteWithImage"
				>
					Nouvelle note avec cette image
				</li>
				<li
					class="intent__item"
					t-foreach="state.notes"
					t-as="note"
					t-key="note.id"
					t-att-data-id="note.id"
					t-on-click.stop.prevent="event => this.addImageToNote(event)"
				>
					<t t-esc="note.title"></t>
				</li>
			</ul>
		</div>
	`;

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({ imageUri: "", notes: [] });
		this.getImageUri();
		this.getNotes();
	}

	newNoteWithImage() {
		this.eventBus.trigger(Events.NEW_NOTE_WITH_IMAGE, { intent: this.props.intent });
	}

	addImageToNote(event: Event) {
		const id = (event.target as HTMLElement).dataset.id;
		const intent = this.props.intent;

		if (!id || !intent || !(intent instanceof ImageIntent)) {
			return;
		}

		this.noteService.addImageToNote(id, intent);
		this.props.hidePopover();
	}

	public async getImageUri() {
		if (!this.props.intent?.url) {
			return "";
		}

		const result = Capacitor.convertFileSrc(this.props.intent.url);

		this.state.imageUri = result;
	}

	public async getNotes() {
		this.state.notes = await this.noteService.getNotes();
	}
}
