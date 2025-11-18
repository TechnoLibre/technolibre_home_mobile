import { useState, xml } from "@odoo/owl";
import { TextIntent } from "../../../../models/intent";
import { EnhancedComponent } from "../../../../js/enhancedComponent";
import { Capacitor } from "@capacitor/core";

export class NoteTextIntentHandlerComponent extends EnhancedComponent {
	static template = xml`
		<div id="note-text-intent-handler-component">
			<h1 class="intent__title">Ajouter du texte</h1>
			<p class="intent__text">
				<t t-esc="state.text"></t>
			</p>
			<h3 class="intent__notes__title">Notes</h3>
			<ul class="intent__notes">
				<li
					class="intent__item intent__item--new"
					t-on-click.stop.prevent="newNoteWithText"
				>
					Nouvelle note avec ce texte
				</li>
				<li
					class="intent__item"
					t-foreach="state.notes"
					t-as="note"
					t-key="note.id"
					t-att-data-id="note.id"
					t-on-click.stop.prevent="event => this.addTextToNote(event)"
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
		this.state = useState({ text: "", notes: [] });
		this.getText();
		this.getNotes();
	}

	newNoteWithText() {
		const intent = this.props.intent;

		if (!intent || !(intent instanceof TextIntent)) {
			return;
		}

		this.noteService.intent.newNoteWithText(intent);
		this.props.goHome();
	}

	addTextToNote(event: Event) {
		const id = (event.target as HTMLElement).dataset.id;
		const intent = this.props.intent;

		if (!id || !intent || !(intent instanceof TextIntent)) {
			return;
		}

		this.noteService.intent.addTextToNote(id, intent);
		this.props.goHome();
	}

	public async getText() {
		if (!this.props.intent?.text) {
			return "";
		}

		this.state.text = this.props.intent.text;
	}

	public async getNotes() {
		this.state.notes = await this.noteService.getNotes();
	}
}
