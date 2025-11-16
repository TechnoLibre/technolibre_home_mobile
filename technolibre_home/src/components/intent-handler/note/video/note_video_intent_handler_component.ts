import { useState, xml } from "@odoo/owl";
import { VideoIntent } from "../../../../models/intent";
import { EnhancedComponent } from "../../../../js/enhancedComponent";
import { Capacitor } from "@capacitor/core";

export class NoteVideoIntentHandlerComponent extends EnhancedComponent {
	static template = xml`
		<div id="note-video-intent-handler-component">
			<h1 class="intent__title">Ajouter une video</h1>
			<video class="intent__thumbnail">
				<source t-att-src="state.videoUri"></source>
			</video>
			<h3 class="intent__notes__title">Notes</h3>
			<ul class="intent__notes" t-if="state.notes.length !== 0">
				<li
					class="intent__item intent__item--new"
					t-on-click.stop.prevent="newNoteWithVideo"
				>
					Nouvelle note avec cette video
				</li>
				<li
					class="intent__item"
					t-foreach="state.notes"
					t-as="note"
					t-key="note.id"
					t-att-data-id="note.id"
					t-on-click.stop.prevent="event => this.addVideoToNote(event)"
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
		this.state = useState({ videoUri: "", notes: [] });
		this.getVideoUri();
		this.getNotes();
	}

	newNoteWithVideo() {
		const intent = this.props.intent;

		if (!intent || !(intent instanceof VideoIntent)) {
			return;
		}

		this.noteService.intent.newNoteWithVideo(intent);
		this.props.hidePopover();
	}

	addVideoToNote(event: Event) {
		const id = (event.target as HTMLElement).dataset.id;
		const intent = this.props.intent;

		if (!id || !intent || !(intent instanceof VideoIntent)) {
			return;
		}

		this.noteService.intent.addVideoToNote(id, intent);
		this.props.hidePopover();
	}

	public async getVideoUri() {
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
