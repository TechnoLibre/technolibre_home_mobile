import { onMounted, onPatched, useRef, xml } from "@odoo/owl";

import { Sortable } from "sortablejs";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { Events } from "../../../constants/events";
import { NoteEntry } from "../../../models/note";

import { NoteEntryComponent } from "../entry/note_entry_component";

export class NoteContentComponent extends EnhancedComponent {
	static template = xml`
		<div id="note__content__wrapper">
			<section
				id="note__content"
				t-on-input.stop.prevent="props.saveNoteData"
			>
				<ul
					id="note__tags__list"
					t-if="props.note.tags.length !== 0"
				>
					<li
						class="note__tag"
						t-foreach="props.note.tags"
						t-as="tag"
						t-key="tag"
					>
						<t t-esc="tag"></t>
					</li>
				</ul>
				<textarea
					type="text"
					t-ref="note-title"
					id="note__title"
					placeholder="Title"
					t-model="props.note.title"
					t-on-keydown="onTitleKeydown"
				/>
				<div id="note__draggables" t-ref="note-entries">
					<NoteEntryComponent
						t-foreach="props.note.entries"
						t-as="entry"
						t-key="entry.id"
						type="entry.type"
						id="entry.id"
						params="entry.params"
						editMode="props.editMode"
						deleteEntry.bind="props.deleteEntry"
					/>
				</div>
			</section>
		</div>
	`;

	static components = { NoteEntryComponent };

	sortable: any = undefined;
	entries = useRef("note-entries");
	private didAutoFocus = false;
	titleRef = useRef("note-title");

	setup() {
		onMounted(this.onMounted.bind(this));

		onPatched(() => {
			if (this.didAutoFocus) return;
			requestAnimationFrame(() => {
				const el = this.titleRef.el as HTMLTextAreaElement | null;
				if (el && el.value.trim() === "") {
					el.focus();
					this.didAutoFocus = true;
				}
			});
		});
	}

	private onTitleKeydown(ev: KeyboardEvent) {
		// Create a new text instead of accept enter into title
		if ((ev as any).isComposing) return;

		if (ev.key === "Enter" && !ev.shiftKey) {
			ev.preventDefault(); // ignore enter into textarea
			this.props.addText?.();
		}
	}

	private onMounted() {
		this.sortable = Sortable.create(this.entries.el, {
			animation: 150,
			easing: "cubic-bezier(0.37, 0, 0.63, 1)",
			ghostClass: "sortable-ghost",
			handle: ".note-entry-drag-component",
			onSort: this.onSort.bind(this)
		});
		this.eventBus.addEventListener(Events.FOCUS_LAST_ENTRY, this.focusLastEntry.bind(this));
	}

	private onSort() {
		this.reorderEntries();
		this.props.saveNoteData();
	}

	private reorderEntries() {
		const entries = this.entries.el;

		if (!entries) {
			return;
		}

		const entryElements = entries.querySelectorAll(".note-entry-component[data-id]");
		const entryIds = Array.from(entryElements).map(entry => (entry as HTMLElement).dataset.id);

		const entryIndexMap = new Map(entryIds.map((id, index) => [id, index]));
		this.props.note.entries.sort(this.sortEntriesCallback.bind(this, entryIndexMap));
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

		const numEntries = this.props.note.entries.length;
		const lastEntry: NoteEntry = this.props.note.entries?.[numEntries - 1];

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
