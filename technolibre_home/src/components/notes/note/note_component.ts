import { onMounted, useRef, useState, xml } from "@odoo/owl";

import { DatetimePicker, PresentResult } from "@capawesome-team/capacitor-datetime-picker";
import { Dialog } from "@capacitor/dialog";
import { Sortable } from "sortablejs";
import { WcDatepicker } from "wc-datepicker/dist/components/wc-datepicker";
import "wc-datepicker/dist/themes/dark.css";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { NoNoteMatchError, NoteKeyNotFoundError, UndefinedNoteListError } from "../../../js/errors";
import { NoteEntry } from "../types";
import { NoteEntryComponent } from "../entry/note_entry_component";
import { WebViewUtils } from "../../../utils/webViewUtils";

import ArchiveNoteIcon from "../../../assets/icon/archive_note.svg";
import AudioIcon from "../../../assets/icon/audio.svg";
import CheckBoxIcon from "../../../assets/icon/check_box.svg";
import CheckBoxBlankIcon from "../../../assets/icon/check_box_blank.svg";
import EditNoteIcon from "../../../assets/icon/edit_note.svg";
import EditDateIcon from "../../../assets/icon/edit_date.svg";
import PinNoteIcon from "../../../assets/icon/pin.svg";
import TagIcon from "../../../assets/icon/tag.svg";
import TextIcon from "../../../assets/icon/text.svg";

export class NoteComponent extends EnhancedComponent {
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
						<p class="greyed-out">Add Audio</p>
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
				<section
					id="note__content"
					t-on-input.stop.prevent="saveNoteData"
				>
					<ul
						id="note__tags__list"
						t-if="state.note.tags.length !== 0"
					>
						<li
							class="note__tag"
							t-foreach="state.note.tags"
							t-as="tag"
							t-key="tag"
						>
							<t t-esc="tag"></t>
						</li>
					</ul>
					<textarea
						type="text"
						id="note__title"
						placeholder="Title"
						t-model="state.note.title"
					>
						<t t-esc="state.note.title"></t>
					</textarea>
					<div id="note__draggables" t-ref="note-entries">
						<NoteEntryComponent
							t-foreach="state.note.entries"
							t-as="entry"
							t-key="entry.id"
							type="entry.type"
							id="entry.id"
							params="entry.params"
							editMode="state.editMode"
						/>
					</div>
				</section>
			</div>
			<div id="note__bottom-controls__wrapper">
				<section id="note__bottom-controls">
					<a
						id="note__control__date"
						class="note__control"
						href="#"
						t-on-click.stop.prevent="onSetDateClick"
					>
						<img src="${EditDateIcon}" />
						<p>Set Date</p>
					</a>
					<a
						id="note__control__tags"
						class="note__control"
						href="#"
						t-on-click.stop.prevent="onTagsClick"
					>
						<img src="${TagIcon}" />
						<p>Tags</p>
					</a>
					<a
						id="note__control__archive"
						class="note__control"
						t-att-class="{
							'note__control__archive--active': state.note.archived
						}"
						href="#"
						t-on-click.stop.prevent="onArchiveClick"
					>
						<img src="${ArchiveNoteIcon}" />
						<p t-if="state.note.archived">Unarchive</p>
						<p t-else="">Archive</p>
					</a>
					<a
						id="note__control__pin"
						class="note__control"
						t-att-class="{
							'note__control__pin--active': state.note.pinned
						}"
						href="#"
						t-on-click.stop.prevent="onPinClick"
					>
						<img src="${PinNoteIcon}" />
						<p t-if="state.note.pinned">Unpin</p>
						<p t-else="">Pin</p>
					</a>
					<a
						id="note__control__done"
						class="note__control"
						href="#"
						t-on-click.stop.prevent="toggleDone"
					>
						<img src="${CheckBoxIcon}" t-if="state.note.done" />
						<img src="${CheckBoxBlankIcon}" t-else="" />
						<p>Done</p>
					</a>
				</section>
			</div>
		</div>
		<div
			id="datepicker__popover"
			popover=""
			t-if="!state.isMobile"
			t-ref="datepicker-popover"
			t-on-click.stop.prevent="onWcDatePickerPopoverClick"
		>
			<div id="datepicker__wrapper" t-on-click.stop.prevent="">
				<wc-datepicker
					t-att-start-date="this.getStartDate()"
					id="datepicker"
					t-ref="datepicker"
					t-on-selectDate="onWcDatePickerSelect"
				></wc-datepicker>
			</div>
		</div>
	`;

	static components = { NoteEntryComponent };

	sortable: any = undefined;
	entries = useRef("note-entries");
	wcDatePickerPopover = useRef("datepicker-popover");
	wcDatePicker = useRef("datepicker");

	setup() {
		this.state = useState({
			noteId: undefined,
			note: this.noteService.getNewNote(),
			newNote: false,
			editMode: false,
			isMobile: WebViewUtils.isMobile()
		});
		onMounted(this.onMounted.bind(this));
		this.setParams();
		this.getNote();
	}

	private onMounted() {
		if (!customElements.get("wc-datepicker")) {
			customElements.define("wc-datepicker", WcDatepicker);
		}

		this.sortable = Sortable.create(this.entries.el, {
			animation: 150,
			easing: "cubic-bezier(0.37, 0, 0.63, 1)",
			ghostClass: "sortable-ghost",
			handle: ".note-entry-drag-component",
			onSort: this.onSort.bind(this)
		});
	}

	addAudio() {
		console.log("Add Audio");
	}

	addText() {
		this.state.note.entries.push(this.noteService.getNewTextEntry());
		this.saveNoteData();
		this.focusLastEntry();
	}

	onSetDateClick() {
		WebViewUtils.isMobile() ? this.setDateMobile() : this.setDateWeb();
	}

	onTagsClick() {
		console.log("onTagsClick()");
	}

	onArchiveClick() {
		this.state.note.archived = !this.state.note.archived;
		this.saveNoteData();
	}

	onPinClick() {
		this.state.note.pinned = !this.state.note.pinned;
		this.saveNoteData();
	}

	private async setDateMobile() {
		const presentResult: PresentResult = await DatetimePicker.present({
			mode: "date"
		});
		const date = new Date(presentResult.value);
		date.setHours(0, 0, 0, 0);
		this.setDate(date.toISOString());
	}

	private setDateWeb() {
		if (!this.wcDatePickerPopover.el) {
			return;
		}

		this.wcDatePickerPopover.el.showPopover();
	}

	onWcDatePickerPopoverClick() {
		if (!this.wcDatePickerPopover.el) {
			return;
		}
		this.wcDatePickerPopover.el.hidePopover();
	}

	onWcDatePickerSelect() {
		if (!this.wcDatePickerPopover.el || !this.wcDatePicker.el) {
			return;
		}
		const date = new Date((this.wcDatePicker.el as any)?.value);
		this.setDate(date.toISOString());
		this.wcDatePickerPopover.el.hidePopover();
	}

	toggleDone() {
		this.state.note.done = !this.state.note.done;
		this.saveNoteData();
	}

	toggleEditMode() {
		this.state.editMode = !this.state.editMode;
	}

	onSort() {
		this.reorderEntries();
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

	private setDate(date: string) {
		this.state.note.date = date;
		this.saveNoteData();
	}

	private getStartDate() {
		const date = this.state.note.date ? new Date(this.state.note.date) : new Date();
		return date.toISOString().split("T")[0];
	}

	private reorderEntries() {
		const entries = this.entries.el;

		if (!entries) {
			return;
		}

		const entryElements = entries.querySelectorAll(".note-entry-component[data-id]");
		const entryIds = Array.from(entryElements).map(entry => (entry as HTMLElement).dataset.id);

		const entryIndexMap = new Map(entryIds.map((id, index) => [id, index]));
		this.state.note.entries.sort(this.sortEntriesCallback.bind(this, entryIndexMap));
	}

	private sortEntriesCallback(entryIndexMap: Map<string, number>, entryOne: NoteEntry, entryTwo: NoteEntry) {
		const indexOne = entryIndexMap.get(entryOne.id);
		const indexTwo = entryIndexMap.get(entryTwo.id);

		if (indexOne === undefined && indexTwo === undefined) {
			return 0;
		} else if (indexOne === undefined) {
			return 1;
		} else if (indexTwo === undefined) {
			return -1;
		}

		return indexOne - indexTwo;
	}

	private focusLastEntry() {
		if (!this.entries.el) {
			return;
		}

		const numEntries = this.state.note.entries.length;
		const lastEntry: NoteEntry = this.state.note.entries?.[numEntries - 1];

		const observer = new MutationObserver(this.entryMutationCallback.bind(this, lastEntry));

		observer.observe(this.entries.el, { childList: true });
	}

	private entryMutationCallback(lastEntry: NoteEntry, mutationList: MutationRecord[], observer: MutationObserver) {
		if (!this.entries.el) {
			return;
		}

		if (mutationList?.[0].type === "childList") {
			const matchingEl = this.entries.el.querySelector(`textarea[id='${lastEntry.id}']`);

			if (!matchingEl) {
				return;
			}

			const textAreaEl: HTMLTextAreaElement = matchingEl as HTMLTextAreaElement;
			textAreaEl.focus();
			observer.disconnect();
		}
	}
}
