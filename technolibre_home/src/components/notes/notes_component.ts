import { Component, useState, xml } from "@odoo/owl";

import { HeadingComponent } from "../heading/heading_component";
import { NotesItemComponent } from "./item/notes_item_component";
import { Note } from "./types";
import { BiometryUtils } from "../../utils/biometryUtils";
import { Dialog } from "@capacitor/dialog";
import { ErrorMessages } from "../../js/errors";
import { Constants } from "../../js/constants";
import NoteAddIcon from "../../assets/icon/note_add.svg";

export class NotesComponent extends Component {
	static template = xml`
		<div id="notes-component">
			<header id="notes-header">
				<h1 id="notes-heading">Notes</h1>
				<a
					id="notes-add"
					t-on-click.stop.prevent="onNoteAddClick"
				>
					<img src="${NoteAddIcon}" />
				</a>
			</header>
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
		this.state.notes.push({ id: "1", title: "MockNoteOne" });
		this.state.notes.push({ id: "2", title: "MockNoteTwo", date: "2025-09-12" });
		this.state.notes.push({ id: "3", title: "MockNoteThree" });
	}

	openNote(noteId: string) {
		const encodedId = encodeURIComponent(noteId);
		this.env.eventBus.trigger(Constants.ROUTER_NAVIGATION_EVENT_NAME, {
			url: `/note/${encodedId}`
		});
	}

	editNote(noteId: string) {
		const encodedId = encodeURIComponent(noteId);
		this.env.eventBus.trigger(Constants.ROUTER_NAVIGATION_EVENT_NAME, {
			url: `/notes/edit/${encodedId}`
		});
	}

	async deleteNote(noteId: string) {
		const deleteConfirmed = confirm(`Voulez-vous vraiment supprimer cette note?`);

		if (!deleteConfirmed) {
			return;
		}

		const isBiometricAuthSuccessful: boolean = await BiometryUtils.authenticateIfAvailable();

		if (!isBiometricAuthSuccessful) {
			Dialog.alert({ message: ErrorMessages.BIOMETRIC_AUTH });
			return;
		}

		let deleteSucceeded: boolean = false;

		try {
			deleteSucceeded = await this.env.noteService.delete(noteId);
		} catch (error: unknown) {
			Dialog.alert({ message: ErrorMessages.NOTE_DELETE });
			return;
		}

		if (!deleteSucceeded) {
			Dialog.alert({ message: ErrorMessages.NOTE_DELETE });
			return;
		}

		this.state.notes = await this.env.noteService.getNotes();
	}

	onNoteAddClick() {
		this.env.eventBus.trigger(Constants.ROUTER_NAVIGATION_EVENT_NAME, { url: "/note/new" });
	}
}
