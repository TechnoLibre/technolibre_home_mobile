import { Capacitor } from "@capacitor/core";
import { useState, xml } from "@odoo/owl";
import { EnhancedComponent } from "../../../../js/enhancedComponent";
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
					<p class="intent__item__title" t-if="note.title">
						<t t-esc="note.title"></t>
					</p>
					<p class="intent__item__title--empty" t-else="">
						Sans titre
					</p>
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
		const intent = this.props.intent;

		if (!intent || !(intent instanceof ImageIntent)) {
			return;
		}

		this.noteService.newNoteWithImage(intent);
		this.props.hidePopover();
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
