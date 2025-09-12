import { Component, useState, xml } from "@odoo/owl";

import { HeadingComponent } from "../heading/heading_component";
import { NotesItemComponent } from "./item/notes_item_component";
import { Note } from "./types";

export class NotesComponent extends Component {
	static template = xml`
		<div id="notes-component">
			<HeadingComponent title="'Notes'"/>
			<section id="notes">
				<ul id="notes-list" t-if="state.notes.length !== 0">
					<NotesItemComponent
						t-foreach="state.notes"
						t-as="noteItem"
						t-key="noteItem.id"
						note="noteItem"
						openNote.bind="openNote"
						editNote.bind="editNote"
						deleteNote.bind="deleteNote"
					/>
				</ul>
				<div id="notes-empty" t-else="">
					<p>Il n'y a pas de note dans le stockage local.</p>
				</div>
			</section>
		</div>
	`;

	static components = { HeadingComponent, NotesItemComponent };

	state: any = undefined;

	setup() {
		this.state = useState({ notes: new Array<Note>() });

		// Mock Notes
		this.state.notes.push({ id: "1", title: "NoteOne" });
		this.state.notes.push({ id: "2", title: "NoteTwo", date: "2025-09-12" });
		this.state.notes.push({ id: "3", title: "NoteThree" });
	}

	openNote(noteId: string) {
		console.log(`TODO: Open note ${noteId}.`);
	}

	editNote(noteId: string) {
		console.log(`TODO: Edit note ${noteId}.`);
	}

	deleteNote(noteId: string) {
		console.log(`TODO: Delete note ${noteId}.`);
	}
}
