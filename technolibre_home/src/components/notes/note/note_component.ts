import { useState, xml } from "@odoo/owl";

import { Dialog } from "@capacitor/dialog";

import "wc-datepicker/dist/themes/dark.css";

import { Constants } from "../../../js/constants";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { NoNoteMatchError, NoteKeyNotFoundError, UndefinedNoteListError } from "../../../js/errors";

import { DatePickerComponent } from "../date_picker/date_picker_component";
import { NoteBottomControlsComponent } from "../bottom_controls/note_bottom_controls_component";
import { NoteContentComponent } from "../content/note_content_component";
import { NoteTopControlsComponent } from "../../notes/top_controls/note_top_controls_component";
import { TagManagerComponent } from "../tag_manager/tag_manager_component";

export class NoteComponent extends EnhancedComponent {
	static template = xml`
		<div id="note-component">
			<NoteTopControlsComponent
				addAudio.bind="addAudio"
				addText.bind="addText"
				toggleEditMode.bind="toggleEditMode"
			/>
			<NoteContentComponent
				note="state.note"
				editMode="state.editMode"
				saveNoteData.bind="saveNoteData"
			/>
			<NoteBottomControlsComponent
				note="state.note"
				onSetDateClick.bind="onSetDateClick"
				onTagsClick.bind="onTagsClick"
				onArchiveClick.bind="onArchiveClick"
				onPinClick.bind="onPinClick"
				toggleDone.bind="toggleDone"
			/>
		</div>
		<DatePickerComponent note="state.note" setNoteDate.bind="setNoteDate" />
		<TagManagerComponent />
	`;

	static components = {
		DatePickerComponent,
		NoteBottomControlsComponent,
		NoteContentComponent,
		NoteTopControlsComponent,
		TagManagerComponent
	};

	setup() {
		this.state = useState({
			noteId: undefined,
			note: this.noteService.getNewNote(),
			newNote: false,
			editMode: false
		});
		this.setParams();
		this.getNote();
	}

	addAudio() {
		console.log("Add Audio");
	}

	addText() {
		this.state.note.entries.push(this.noteService.getNewTextEntry());
		this.saveNoteData();
		this.focusLastEntry();
	}

	toggleEditMode() {
		this.state.editMode = !this.state.editMode;
	}

	onSetDateClick() {
		this.eventBus.trigger(Constants.DATE_PICKER_EVENT_NAME);
	}

	onTagsClick() {
		this.eventBus.trigger(Constants.TAG_MANAGER_EVENT_NAME);
	}

	onArchiveClick() {
		this.state.note.archived = !this.state.note.archived;
		this.saveNoteData();
	}

	onPinClick() {
		this.state.note.pinned = !this.state.note.pinned;
		this.saveNoteData();
	}

	toggleDone() {
		this.state.note.done = !this.state.note.done;
		this.saveNoteData();
	}

	setNoteDate(date: string) {
		this.state.note.date = date;
		this.saveNoteData();
	}

	async saveNoteData() {
		try {
			if (this.state.newNote) {
				await this.noteService.add(this.state.note);
				this.state.newNote = false;
			} else {
				await this.noteService.edit(this.state.noteId, this.state.note);
			}
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
				return;
			}
		}
	}

	private setParams() {
		const params = this.router.getRouteParams(window.location.pathname);
		this.state.noteId = decodeURIComponent(params?.["id"] || "");
	}

	private async getNote() {
		try {
			this.state.note = await this.noteService.getMatch(this.state.noteId);
		} catch (error: unknown) {
			if (error instanceof NoteKeyNotFoundError || error instanceof UndefinedNoteListError) {
				Dialog.alert({ message: error.message });
				return;
			} else if (error instanceof NoNoteMatchError && this.noteService.isValidId(this.state.noteId)) {
				this.state.newNote = true;
				this.state.note = this.noteService.getNewNote(this.state.noteId);
			}
		}
	}

	private focusLastEntry() {
		this.eventBus.trigger(Constants.FOCUS_LAST_ENTRY_EVENT_NAME);
	}
}
