import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { NoteListItemHandleComponent } from "./handle/note_list_item_handle_component";
import { Tag } from "../../../models/tag";

import DeleteIcon from "../../../assets/icon/delete.svg";
// @ts-ignore
import CloudSyncIcon from "../../../assets/icon/cloud_sync.svg";

export class NotesItemComponent extends EnhancedComponent {
    // Module-level constants exposed to the static template so the xml`...`
    // literal stays interpolation-free and AOT-precompilable.
    cloudSyncIcon = CloudSyncIcon;
    deleteIcon = DeleteIcon;

	static template = xml`
		<li
			class="notes-item"
			t-att-data-id="props.note.id"
			t-att-class="{
				'notes-item--done': props.note.done,
				'has-tags': resolvedTags().length !== 0,
				'notes-item--priority-1': props.note.priority === 1,
				'notes-item--priority-2': props.note.priority === 2,
				'notes-item--priority-3': props.note.priority === 3,
				'notes-item--priority-4': props.note.priority === 4,
			}"
			role="button"
			tabindex="0"
			t-att-aria-label="'Ouvrir la note : ' + (props.note.title || '(Sans titre)')"
			t-on-click="() => this.props.openNote(props.note.id)"
			t-on-keydown="(ev) => (ev.key === 'Enter' || ev.key === ' ') ? this.props.openNote(props.note.id) : null"
		>
			<NoteListItemHandleComponent
				editMode="props.editMode"
			/>
			<t t-set="resolvedTagList" t-value="resolvedTags()" />
			<div
				class="notes-item__tags"
				t-if="resolvedTagList.length !== 0"
				t-on-click.stop.prevent=""
			>
				<div
					t-foreach="resolvedTagList"
					t-as="rt"
					t-key="rt.id"
					class="notes-item__tag"
					t-att-style="'background-color:' + rt.color"
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
						t-att-aria-label="(props.syncSynced > 0 ? props.syncSynced + ' sync' : '') + (props.syncError > 0 ? ' ' + props.syncError + ' erreur(s)' : '')"
					>
						<img t-att-src="cloudSyncIcon" alt="" aria-hidden="true"/>
						<span
							t-if="props.syncSynced > 0"
							class="notes-item__sync-count--synced"
							t-esc="props.syncSynced"
							aria-hidden="true"
						/>
						<span
							t-if="props.syncError > 0"
							class="notes-item__sync-count--error"
							t-esc="props.syncError"
							aria-hidden="true"
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
					t-att-aria-label="'Supprimer : ' + (props.note.title || '(Sans titre)')"
					t-on-click.stop.prevent="() => this.props.deleteNote(props.note.id)"
				>
					<img t-att-src="deleteIcon" alt="" aria-hidden="true"/>
				</button>
			</div>
		</li>
	`;

	static components = { NoteListItemHandleComponent };

	/** Resolve tag IDs to Tag objects using the reactive tagMap prop. */
	resolvedTags(): Tag[] {
		const tagMap: Record<string, Tag> = this.props.tagMap ?? {};
		return this.props.note.tags
			.map((id: string) => tagMap[id])
			.filter((t): t is Tag => t !== undefined);
	}

	formatDate(date: Date) {
		return new Date(date).toLocaleDateString();
	}
}
