import { useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";

import { HeadingComponent } from "../heading/heading_component";
import { NotesItemComponent } from "./item/notes_item_component";
import { Note } from "./types";
import { BiometryUtils } from "../../utils/biometryUtils";
import { Dialog } from "@capacitor/dialog";
import { ErrorMessages } from "../../js/errors";
import { Constants } from "../../js/constants";
import NoteAddIcon from "../../assets/icon/note_add.svg";
import ToggleOffIcon from "../../assets/icon/toggle_off.svg";
import ToggleOnIcon from "../../assets/icon/toggle_on.svg";

export class NotesComponent extends EnhancedComponent {
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
			<section id="notes__controls">
				<a
					class="notes__control notes__control__show-archived"
					t-att-class="{
						'notes__control__show-archived--true': state.showArchivedNotes,
						'notes__control__show-archived--false': !state.showArchivedNotes
					}"
					href="#"
					t-on-click.stop.prevent="onToggleNoteListClick"
				>
					<p>Montrer les notes archivées</p>
					<img src="${ToggleOnIcon}" t-if="state.showArchivedNotes" />
					<img src="${ToggleOffIcon}" t-else="" />
				</a>
			</section>
			<section id="notes">
				<t t-set="currentNoteList" t-value="getCurrentNoteList()"></t>
				<t t-set="pinned" t-value="getPinned(currentNoteList)"></t>
				<t t-set="unpinned" t-value="getUnpinned(currentNoteList)"></t>
				<div id="notes__pinned" t-if="pinned.length !== 0">
					<h3>Notes épinglées</h3>
					<ul class="notes-list">
						<NotesItemComponent
							t-foreach="pinned"
							t-as="noteItem"
							t-key="noteItem.id"
							note="noteItem"
							openNote.bind="openNote"
							editNote.bind="editNote"
							deleteNote.bind="deleteNote"
						/>
					</ul>
				</div>
				<div id="notes__unpinned" t-if="unpinned.length !== 0">
					<h3>Notes non épinglées</h3>
					<ul class="notes-list">
						<NotesItemComponent
							t-foreach="unpinned"
							t-as="noteItem"
							t-key="noteItem.id"
							note="noteItem"
							openNote.bind="openNote"
							editNote.bind="editNote"
							deleteNote.bind="deleteNote"
						/>
					</ul>
				</div>
				<div id="notes-empty" t-if="currentNoteList.length === 0">
					<p t-if="state.showArchivedNotes">Les notes archivées se trouveront ici.</p>
					<p t-else="">Les notes se trouveront ici.</p>
				</div>
			</section>
		</div>
	`;

	static components = { HeadingComponent, NotesItemComponent };

	setup() {
		this.state = useState({
			notes: new Array<Note>(),
			showArchivedNotes: false
		});
		this.getNotes();
	}

	async getNotes() {
		try {
			this.state.notes = await this.noteService.getNotes();
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
			}
		}
	}

	onNoteAddClick() {
		const newId = this.noteService.getNewId();
		this.eventBus.trigger(Constants.ROUTER_NAVIGATION_EVENT_NAME, { url: `/note/${newId}` });
	}

	onToggleNoteListClick() {
		this.state.showArchivedNotes = !this.state.showArchivedNotes;
	}

	getCurrentNoteList(): Array<Note> {
		if (this.state.showArchivedNotes) {
			return this.state.notes.filter(note => note.archived);
		} else {
			return this.state.notes.filter(note => !note.archived);
		}
	}

	getPinned(noteList: Array<Note>): Array<Note> {
		return noteList.filter(note => note.pinned);
	}

	getUnpinned(noteList: Array<Note>): Array<Note> {
		return noteList.filter(note => !note.pinned);
	}

	openNote(noteId: string) {
		const encodedId = encodeURIComponent(noteId);
		this.eventBus.trigger(Constants.ROUTER_NAVIGATION_EVENT_NAME, {
			url: `/note/${encodedId}`
		});
	}

	editNote(noteId: string) {
		const encodedId = encodeURIComponent(noteId);
		this.eventBus.trigger(Constants.ROUTER_NAVIGATION_EVENT_NAME, {
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
			deleteSucceeded = await this.noteService.delete(noteId);
		} catch (error: unknown) {
			Dialog.alert({ message: ErrorMessages.NOTE_DELETE });
			return;
		}

		if (!deleteSucceeded) {
			Dialog.alert({ message: ErrorMessages.NOTE_DELETE });
			return;
		}

		this.getNotes();
	}
}
