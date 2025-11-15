import { useState, xml } from "@odoo/owl";

import { Dialog } from "@capacitor/dialog";
import { Geolocation, PermissionStatus, Position } from "@capacitor/geolocation";

import { BiometryUtils } from "../../utils/biometryUtils";
import { EnhancedComponent } from "../../js/enhancedComponent";
import { ErrorMessages } from "../../constants/errorMessages";
import { NoNoteEntryMatchError, NoNoteMatchError, NoteKeyNotFoundError, UndefinedNoteListError } from "../../js/errors";
import { Events } from "../../constants/events";
import { Note, NoteEntry, NoteEntryAudioParams, NoteEntryDateParams, NoteEntryPhotoParams, NoteEntryVideoParams } from "../../models/note";

import { DatePickerComponent } from "./date_picker/date_picker_component";
import { NoteBottomControlsComponent } from "./bottom_controls/note_bottom_controls_component";
import { NoteContentComponent } from "./content/note_content_component";
import { NoteTopControlsComponent } from "./top_controls/note_top_controls_component";
import { TagManagerComponent } from "./tag_manager/tag_manager_component";
import { ImageIntent } from "../../models/intent";

export class NoteComponent extends EnhancedComponent {
	static template = xml`
		<div id="note-component">
			<NoteTopControlsComponent
				addAudio.bind="addAudio"
				addLocation.bind="addLocation"
				addText.bind="addText"
				addDateEntry.bind="addDateEntry"
				addPhoto.bind="addPhoto"
				addVideo.bind="addVideo"
			/>
			<NoteContentComponent
				note="state.note"
				editMode="state.editMode"
				saveNoteData.bind="saveNoteData"
				addText.bind="addText"
				deleteEntry.bind="deleteEntry"
			/>
			<NoteBottomControlsComponent
				note="state.note"
				toggleEditMode.bind="toggleEditMode"
				onTagsClick.bind="onTagsClick"
				onArchiveClick.bind="onArchiveClick"
				onPinClick.bind="onPinClick"
				toggleDone.bind="toggleDone"
				toggleOptionMode.bind="toggleOptionMode"
				optionMode="state.optionMode"
			/>
		</div>
		<DatePickerComponent
			note="state.note"
			setEntryDate.bind="setEntryDate"
		/>
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
			editMode: true,
			optionMode: false
		});
		this.setParams();
		this.getNote();
		this.listenForEvents();
	}

	addAudio() {
		const newEntry = this.noteService.getNewAudioEntry();
		this.state.note.entries.push(newEntry);
		this.saveNoteData();
	}

	addDateEntry() {
		const newEntry = this.noteService.getNewDateEntry();

		const params = newEntry.params as NoteEntryDateParams;

		params.date = (new Date()).toISOString();

		const entries: Array<NoteEntry> = this.state.note.entries;
		
		entries.push(newEntry);
		this.saveNoteData();
	}

	async addLocation() {
		const permissions = await this.getGeolocationPermissions();

		if (!permissions || permissions.location === "denied") {
			return;
		}

		const currentPosition: Position = await Geolocation.getCurrentPosition();
		const newEntry = this.noteService.getNewGeolocationEntry();

		newEntry.params = {
			text: "Données de géolocalisation",
			latitude: currentPosition.coords.latitude,
			longitude: currentPosition.coords.longitude,
			timestamp: currentPosition.timestamp
		};

		this.state.note.entries.push(newEntry);
		this.saveNoteData();
	}

	addPhoto() {
		this.state.note.entries.push(this.noteService.getNewPhotoEntry());
		this.saveNoteData();
		this.focusLastEntry();
	}

	addText() {
		this.state.note.entries.push(this.noteService.getNewTextEntry());
		this.saveNoteData();
		this.focusLastEntry();
	}

	addVideo() {
		this.state.note.entries.push(this.noteService.getNewVideoEntry());
		this.saveNoteData();
		this.focusLastEntry();
	}

	async deleteEntry(entryId: string) {
		const isBiometricAuthSuccessful: boolean = await BiometryUtils.authenticateIfAvailable();

		if (!isBiometricAuthSuccessful) {
			Dialog.alert({ message: ErrorMessages.BIOMETRIC_AUTH });
			return;
		}

		const entries: Array<NoteEntry> = this.state.note.entries;
		const entryIndex = entries.findIndex(entry => entry.id === entryId);

		if (entryIndex === -1) {
			Dialog.alert({ message: ErrorMessages.NO_NOTE_ENTRY_MATCH });
			return;
		}

		entries.splice(entryIndex, 1);
		this.saveNoteData();
	}

	toggleEditMode() {
		this.state.editMode = !this.state.editMode;
	}

	toggleOptionMode() {
		this.state.optionMode = !this.state.optionMode;
	}

	onTagsClick() {
		this.eventBus.trigger(Events.TAG_MANAGER);
	}

	onArchiveClick() {
		this.state.note.archived = !this.state.note.archived;
		this.saveNoteData();
	}

	onPinClick() {
		this.state.note.pinned = !this.state.note.pinned;
		this.saveNoteData();
	}

	setEntryDate(entryId: string, date: string) {
		let entry: NoteEntry | undefined;

		try {
			entry = this.getEntry(entryId);
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
				return;
			}
		}

		if (!entry) {
			Dialog.alert({ message: ErrorMessages.NO_NOTE_ENTRY_MATCH });
			return;
		}

		if (entry.type !== "date") {
			return;
		}

		const params = entry.params as NoteEntryDateParams;

		params.date = date;
		this.saveNoteData();
	}

	toggleDone() {
		this.state.note.done = !this.state.note.done;
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
		this.state.noteId = decodeURIComponent(params?.get("id") || "");
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
				this.state.note.date = (new Date()).toISOString();
			}
		}
	}

	private listenForEvents() {
		this.eventBus.addEventListener(Events.SET_AUDIO_RECORDING, this.setAudioRecording.bind(this));
		this.eventBus.addEventListener(Events.SET_VIDEO_RECORDING, this.setVideoRecording.bind(this));
	}

	private focusLastEntry() {
		this.eventBus.trigger(Events.FOCUS_LAST_ENTRY);
	}

	private getEntry(entryId: string): NoteEntry {
		const entryIndex = this.getEntryIndex(entryId);

		if (entryIndex === -1) {
			throw new NoNoteEntryMatchError();
		}

		const entries: Array<NoteEntry> = this.state.note.entries;

		const entry: NoteEntry | undefined = entries.at(entryIndex);

		if (!entry) {
			throw new NoNoteEntryMatchError();
		}

		return entry;
	}

	private getEntryIndex(entryId: string): number {
		const entries: Array<NoteEntry> = this.state.note.entries;
		return entries.findIndex(entry => entry.id === entryId);
	}

	private async getGeolocationPermissions(): Promise<PermissionStatus | undefined> {
		let permissions: PermissionStatus | undefined;

		try {
			permissions = await Geolocation.checkPermissions();
		} catch (error: unknown) {
			if (error instanceof Error) {
				return undefined;
			}
		}

		return permissions;
	}

	private setAudioRecording(event: any) {
		const details = event?.detail;
		
		if (!details?.entryId || !details?.path) {
			return;
		}

		let entry: NoteEntry | undefined;

		try {
			entry = this.getEntry(details.entryId);
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
				return;
			}
		}

		if (!entry) {
			Dialog.alert({ message: ErrorMessages.NO_NOTE_ENTRY_MATCH });
			return;
		}

		if (entry.type !== "audio") {
			return;
		}

		const params = entry.params as NoteEntryAudioParams;

		params.path = details.path;
		this.saveNoteData();
	}

	private setVideoRecording(event: any) {
		const details = event?.detail;

		if (!details?.entryId || !details?.path) {
			return;
		}

		let entry: NoteEntry | undefined;

		try {
			entry = this.getEntry(details.entryId);
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
				return;
			}
		}

		if (!entry) {
			Dialog.alert({ message: ErrorMessages.NO_NOTE_ENTRY_MATCH });
			return;
		}

		if (entry.type !== "video") {
			return;
		}

		const params = entry.params as NoteEntryVideoParams;

		params.path = details.path;

		this.saveNoteData();
	}
}
