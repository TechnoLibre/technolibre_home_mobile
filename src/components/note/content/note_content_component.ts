import { onMounted, onPatched, onWillStart, useState, useRef, xml } from "@odoo/owl";

import { Sortable } from "sortablejs";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { Events } from "../../../constants/events";
import { NoteEntry } from "../../../models/note";
import { Tag } from "../../../models/tag";

import { NoteEntryComponent } from "../../note_entry/note_entry_component";

export class NoteContentComponent extends EnhancedComponent {
	static template = xml`
		<div id="note__content__wrapper">
			<section
				id="note__content"
				t-on-input.stop.prevent="props.saveNoteData"
			>
				<t t-set="resolvedTagList" t-value="resolvedTags()" />
				<ul
					id="note__tags__list"
					t-if="resolvedTagList.length !== 0"
				>
					<li
						class="note__tag"
						t-foreach="resolvedTagList"
						t-as="rt"
						t-key="rt.id"
						t-att-style="'background-color:' + rt.color"
					>
						<t t-esc="rt.name"></t>
					</li>
				</ul>
				<textarea
					type="text"
					t-ref="note-title"
					id="note__title"
					placeholder="Titre"
					aria-label="Titre de la note"
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
	state!: { tagMap: Record<string, Tag> };

	resolvedTags(): Tag[] {
		return this.props.note.tags
			.map((id: string) => this.state.tagMap[id])
			.filter((t: Tag | undefined): t is Tag => t !== undefined);
	}

	private async getTags() {
		try {
			const tags = await this.tagService.getAllTags();
			this.state.tagMap = Object.fromEntries(tags.map((t) => [t.id, t]));
		} catch { /* non-critical */ }
	}

	setup() {
		this.state = useState({ tagMap: {} as Record<string, Tag> });
		onWillStart(() => this.getTags());
		onMounted(this.onMounted.bind(this));

		onPatched(() => {
			if (this.didAutoFocus) return;
			requestAnimationFrame(() => {
				if (this.didAutoFocus) return;
				const el = this.titleRef.el as HTMLTextAreaElement | null;
				if (el && el.value.trim() === "") {
					el.focus({ preventScroll: true });
					// On Android WebView, .focus() alone places the textarea
					// in focus state but the visible caret only appears after
					// a real touch event. Dispatching a synthetic click +
					// setSelectionRange(0, 0) gives us both: caret at
					// position 0, ready for typing, no keyboard popped.
					try {
						el.click();
						el.setSelectionRange(0, 0);
					} catch { /* very old WebView: ignore */ }
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
		this.eventBus.addEventListener(Events.SCROLL_TO_LAST_ENTRY, this.scrollToLastEntry.bind(this));
		this.eventBus.addEventListener(Events.TAGS_UPDATED, () => this.getTags());
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

	private scrollToLastEntry() {
		if (!this.entries.el) return;
		const lastEntry: NoteEntry | undefined = this.props.note.entries.at(-1);
		if (!lastEntry) return;

		const selector = `.note-entry-component[data-id='${lastEntry.id}']`;
		const existing = this.entries.el.querySelector(selector);
		if (existing) {
			existing.scrollIntoView({ behavior: "smooth", block: "nearest" });
			return;
		}

		const observer = new MutationObserver((_mutations, obs) => {
			if (!this.entries.el) { obs.disconnect(); return; }
			const el = this.entries.el.querySelector(selector);
			if (el) {
				el.scrollIntoView({ behavior: "smooth", block: "nearest" });
				obs.disconnect();
			}
		});
		observer.observe(this.entries.el, { childList: true });
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
