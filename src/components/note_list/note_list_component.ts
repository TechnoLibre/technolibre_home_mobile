import { onMounted, useRef, useState, xml } from "@odoo/owl";

import { Sortable } from "sortablejs";

import { BiometryUtils } from "../../utils/biometryUtils";
import { Dialog } from "@capacitor/dialog";
import { EnhancedComponent } from "../../js/enhancedComponent";
import { ErrorMessages } from "../../constants/errorMessages";
import { Events } from "../../constants/events";
import { Note } from "../../models/note";

import { HeadingComponent } from "../heading/heading_component";
import { NotesItemComponent } from "./item/note_list_item_component";
import { NoteListControlsComponent } from "./controls/note_list_controls_component";

// @ts-ignore
import NoteAddIcon from "../../assets/icon/note_add.svg";

const ENV = {
    // @ts-ignore
    TITLE: import.meta.env.VITE_TITLE ?? "TITLE",
    // @ts-ignore
    LABEL_NOTE: import.meta.env.VITE_LABEL_NOTE ?? "Note",
    // @ts-ignore
    LOGO_KEY: import.meta.env.VITE_LOGO_KEY ?? "techno",
    // @ts-ignore
    WEBSITE_URL: import.meta.env.VITE_WEBSITE_URL ?? "https://erplibre.ca",
    // @ts-ignore
    DEBUG_DEV: import.meta.env.VITE_DEBUG_DEV === "true",
};

export class NoteListComponent extends EnhancedComponent {
	static template = xml`
		<div id="note-list-component">
			<header id="notes-header">
				<h1 id="notes-heading">${ENV.LABEL_NOTE}s</h1>
				<a
					id="notes-add"
					t-on-click.stop.prevent="onNoteAddClick"
				>
					<img src="${NoteAddIcon}" />
				</a>
			</header>
			<NoteListControlsComponent
				editMode="state.editMode"
				showArchivedNotes="state.showArchivedNotes"
				onToggleNoteListClick.bind="onToggleNoteListClick"
				onToggleEditModeClick.bind="onToggleEditModeClick"
			/>
			<section id="notes" t-ref="notes">
				<t t-set="currentNoteList" t-value="getCurrentNoteList()"></t>
				<t t-set="pinned" t-value="getPinned(currentNoteList)"></t>
				<t t-set="unpinned" t-value="getUnpinned(currentNoteList)"></t>
				<div
					id="notes__pinned"
					t-att-class="{
						'active': pinned.length !== 0
					}"
				>
					<h3>Notes épinglées</h3>
					<ul class="notes-list" t-ref="pinned">
						<NotesItemComponent
							t-foreach="pinned"
							t-as="noteItem"
							t-key="noteItem.id"
							note="noteItem"
							editMode="state.editMode"
							openNote.bind="openNote"
							editNote.bind="editNote"
							deleteNote.bind="deleteNote"
							onSort.bind="onSort"
						/>
					</ul>
				</div>
				<div
					id="notes__unpinned"
					t-att-class="{
						'active': unpinned.length !== 0
					}"
				>
					<h3>Notes non épinglées</h3>
					<ul class="notes-list" t-ref="unpinned">
						<NotesItemComponent
							t-foreach="unpinned"
							t-as="noteItem"
							t-key="noteItem.id"
							note="noteItem"
							editMode="state.editMode"
							openNote.bind="openNote"
							editNote.bind="editNote"
							deleteNote.bind="deleteNote"
							onSort.bind="onSort"
						/>
					</ul>
				</div>
				<div id="notes-empty" t-if="currentNoteList.length === 0">
					<p t-if="state.showArchivedNotes">Aucune ${ENV.LABEL_NOTE} archivée.</p>
					<p t-else="">
						<a id="notes-add" t-on-click.stop.prevent="onNoteAddClick">Ajoutez une ${ENV.LABEL_NOTE} 🤖</a>
					</p>
				</div>
			</section>
		</div>
	`;

	static components = { HeadingComponent, NotesItemComponent, NoteListControlsComponent };

	pinnedSortable: any = undefined;
	unpinnedSortable: any = undefined;

	pinnedRef = useRef("pinned");
	unpinnedRef = useRef("unpinned");

	setup() {
		this.state = useState({
			notes: new Array<Note>(),
			showArchivedNotes: false,
			editMode: false
		});
		onMounted(this.onMounted.bind(this));
		this.getNotes();
	}

	private onMounted() {
		this.pinnedSortable = Sortable.create(this.pinnedRef.el, {
			animation: 150,
			easing: "cubic-bezier(0.37, 0, 0.63, 1)",
			ghostClass: "sortable-ghost",
			handle: ".notes-item-handle-component",
			onSort: this.onSort.bind(this, this.pinnedRef)
		});

		this.unpinnedSortable = Sortable.create(this.unpinnedRef.el, {
			animation: 150,
			easing: "cubic-bezier(0.37, 0, 0.63, 1)",
			ghostClass: "sortable-ghost",
			handle: ".notes-item-handle-component",
			onSort: this.onSort.bind(this, this.unpinnedRef)
		});
	}

	onSort(ref: { el: HTMLElement | null }) {
		this.reorderNotes(ref);
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
		this.eventBus.trigger(Events.ROUTER_NAVIGATION, { url: `/note/${newId}` });
	}

	onToggleEditModeClick() {
		this.state.editMode = !this.state.editMode;
	}

	onToggleNoteListClick() {
		this.state.showArchivedNotes = !this.state.showArchivedNotes;
	}

	getCurrentNoteList(): Array<Note> {
		if (this.state.showArchivedNotes) {
			return this.state.notes.filter((note: Note) => note.archived);
		} else {
			return this.state.notes.filter((note: Note) => !note.archived);
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
		this.eventBus.trigger(Events.ROUTER_NAVIGATION, {
			url: `/note/${encodedId}`
		});
	}

	editNote(noteId: string) {
		const encodedId = encodeURIComponent(noteId);
		this.eventBus.trigger(Events.ROUTER_NAVIGATION, {
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
			deleteSucceeded = await this.noteService.crud.delete(noteId);
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

	private get notes(): Array<Note> {
		return this.state.notes;
	}

	private reorderNotes(ref: { el: HTMLElement | null }) {
		const noteList = ref?.el;

		if (!noteList) {
			return;
		}

		const noteItems = Array.from(noteList.getElementsByClassName("notes-item"));
		const ids = noteItems.map(item => { return (item as HTMLElement).dataset.id });

		const stateNoteEnumeration = this.notes
			.filter((note: Note) => ids.includes(note.id))
			.map((note: Note) => this.locateNote(note));
		
		const notesCopy = [...this.notes];

		let i = 0;
		for (const enumeration of stateNoteEnumeration) {
			const note = this.getNoteFromList(ids[i], notesCopy);

			if (!note) {
				return;
			}

			this.notes[enumeration.index] = note;

			i++;
		}

		this.noteService.setNotes(this.notes);
	}

	private locateNote(note: Note): { index: number, id: string } {
		const index = this.notes.findIndex((currentNote: Note) => {
			return currentNote.id === note.id
		});
		
		return { index, id: note.id };
	}

	private getNoteFromList(id: string | undefined, noteList: Array<Note>): Note | undefined {
		return noteList
			.filter((note: Note) => note.id === id)
			?.[0];
	}
}
