import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { NoteListItemHandleComponent } from "./handle/note_list_item_handle_component";

import DeleteIcon from "../../../assets/icon/delete.svg";

export class NotesItemComponent extends EnhancedComponent {
	static template = xml`
		<li
			class="notes-item"
			t-att-data-id="props.note.id"
			t-att-class="{
				'notes-item--done': props.note.done,
				'has-tags': props.note.tags.length !== 0
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
					t-foreach="props.note.tags"
					t-as="tag"
					t-key="tag"
					class="notes-item__tag"
				>
					<t t-esc="tag"></t>
				</div>
			</div>
			<div class="notes-item__data">
				<p class="notes-item__title">
					<t t-esc="props.note.title"></t>
				</p>
				<p
					class="notes-item__date"
					t-att-class="{
						'no-date': !props.note.date
					}"
				>
					<t t-if="props.note.date" t-esc="formatDate(props.note.date)"></t>
					<t t-else="" t-esc="'Sans date'"></t>
				</p>
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

	formatDate(date: Date) {
		return new Date(date).toLocaleDateString();
	}
}
