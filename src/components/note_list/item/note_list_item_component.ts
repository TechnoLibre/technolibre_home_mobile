import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { NoteListItemHandleComponent } from "./handle/note_list_item_handle_component";
import { Tag } from "../../../models/tag";

import DeleteIcon from "../../../assets/icon/delete.svg";
// @ts-ignore
import CloudSyncIcon from "../../../assets/icon/cloud_sync.svg";

export class NotesItemComponent extends EnhancedComponent {
	static template = xml`
		<li
			class="notes-item"
			t-att-data-id="props.note.id"
			t-att-class="{
				'notes-item--done': props.note.done,
				'has-tags': props.note.tags.length !== 0,
				'notes-item--priority-1': props.note.priority === 1,
				'notes-item--priority-2': props.note.priority === 2,
				'notes-item--priority-3': props.note.priority === 3,
				'notes-item--priority-4': props.note.priority === 4,
			}"
			t-on-click="() => this.props.openNote(props.note.id)"
		>
			<NoteListItemHandleComponent
				editMode="props.editMode"
			/>
			<div
				class="notes-item__tags"
				t-if="props.note.tags.length !== 0"
				t-on-click.stop.prevent=""
			>
				<div
					t-foreach="resolvedTags()"
					t-as="rt"
					t-key="rt.id"
					class="notes-item__tag"
					t-att-style="'--tag-color:' + rt.color"
				>
					<t t-esc="rt.name"></t>
				</div>
			</div>
			<div class="notes-item__data">
				<p class="notes-item__title">
					<t t-esc="props.note.title"></t>
				</p>
				<div class="notes-item__date-row">
					<p
						class="notes-item__date"
						t-att-class="{
							'no-date': !props.note.date
						}"
					>
						<t t-if="props.note.date" t-esc="formatDate(props.note.date)"></t>
						<t t-else="" t-esc="'Sans date'"></t>
					</p>
					<div
						class="notes-item__sync-badge"
						t-if="props.syncSynced > 0 || props.syncError > 0"
					>
						<img src="${CloudSyncIcon}" />
						<span
							t-if="props.syncSynced > 0"
							class="notes-item__sync-count--synced"
							t-esc="props.syncSynced"
						/>
						<span
							t-if="props.syncError > 0"
							class="notes-item__sync-count--error"
							t-esc="props.syncError"
						/>
					</div>
				</div>
			</div>
			<div
				class="notes-item__actions"
				t-att-class="{
					'active': props.editMode
				}"
			>
				<button
					type="button"
					class="notes-item__action notes-item__delete"
					t-on-click.stop.prevent="() => this.props.deleteNote(props.note.id)"
				>
					<img src="${DeleteIcon}" />
				</button>
			</div>
		</li>
	`;

	static components = { NoteListItemHandleComponent };

	/** Resolve tag IDs to Tag objects using the in-memory cache. */
	resolvedTags(): Tag[] {
		const cached = this.tagService.getCached();
		return this.props.note.tags
			.map((id: string) => cached.find((t) => t.id === id))
			.filter((t): t is Tag => t !== undefined);
	}

	formatDate(date: Date) {
		return new Date(date).toLocaleDateString();
	}
}
