import { Component, onMounted, useRef, useState, xml } from "@odoo/owl";

import { Dialog } from "@capacitor/dialog";
import { Sortable } from "sortablejs";

import { ErrorMessages } from "../../../js/errors";
import { Note } from "../types";
import { NoteEntryComponent } from "../entry/note_entry_component";
import { NoteService } from "../../../js/noteService";
import { SimpleRouter } from "../../../js/router";

import AudioIcon from "../../../assets/icon/audio.svg";
import EditNoteIcon from "../../../assets/icon/edit_note.svg";
import TextIcon from "../../../assets/icon/text.svg";

export class NoteComponent extends Component {
	static template = xml`
		<div id="note-component">
			<div id="note__controls__wrapper">
				<section id="note__controls">
					<a
						id="note__control__audio"
						class="note__control"
						href="#"
						t-on-click.stop.prevent="addAudio"
					>
						<img src="${AudioIcon}" />
						<p>Add Audio</p>
					</a>
					<a
						id="note__control__text"
						class="note__control"
						href="#"
						t-on-click.stop.prevent="addText"
					>
						<img src="${TextIcon}" />
						<p>Add Text</p>
					</a>
					<a
						id="note__control__edit"
						class="note__control"
						href="#"
						t-on-click.stop.prevent="toggleEditMode"
					>
						<img src="${EditNoteIcon}" />
						<p>Edit Mode</p>
					</a>
				</section>
			</div>
			<div id="note__content__wrapper">
				<section id="note__content">
					<NoteEntryComponent type="'title'" editMode="state.editMode" />
					<div id="note__draggables" t-ref="note-entries">
						<NoteEntryComponent type="'audio'" editMode="state.editMode" />
						<NoteEntryComponent type="'text'" editMode="state.editMode" />
					</div>
				</section>
			</div>
		</div>
	`;

	static components = { NoteEntryComponent };

	state: any = undefined;
	sortable: any = undefined;
	entries = useRef("note-entries");

	setup() {
		this.state = useState({
			noteId: undefined,
			note: undefined,
			newNote: false,
			editMode: false
		});
		onMounted(() => {
			this.sortable = Sortable.create(this.entries.el, {
				animation: 150,
				easing: "cubic-bezier(0.37, 0, 0.63, 1)",
				filter: ".note-entry-title-component",
				ghostClass: "sortable-ghost",
				handle: ".note-entry-drag-component"
			});
			console.log(this.sortable);
		});
		this.setParams();
		this.getNote();
	}

	addAudio() {
		console.log("Add Audio");
	}

	addText() {
		console.log("Add Text");
	}

	toggleEditMode() {
		this.state.editMode = !this.state.editMode;
	}

	private setParams() {
		const router: SimpleRouter = this.env.router;
		const params = router.getRouteParams(window.location.pathname);

		if (params?.["id"]) {
			this.state.noteId = decodeURIComponent(params?.["id"]);
		} else {
			this.state.newNote = true;
		}
	}

	private async getNote() {
		if (this.state.newNote) {
			return;
		}

		const noteService: NoteService = this.env.noteService;
		let matchingNote: Note | undefined;

		try {
			matchingNote = await noteService.getMatch(this.state.noteId);
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
				return;
			}
		}

		if (!matchingNote) {
			Dialog.alert({ message: ErrorMessages.NO_NOTE_MATCH });
			return;
		}

		console.log(this.state.note);
		this.state.note = matchingNote;
		console.log(this.state.note);
	}
}
