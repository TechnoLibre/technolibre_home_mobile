import { Component, useState, xml } from "@odoo/owl";

import DeleteIcon from "../../../assets/icon/delete.svg";
import EditIcon from "../../../assets/icon/edit.svg";

export class NotesItemComponent extends Component {
	static template = xml`
		<li
			class="notes-item"
			t-on-click="() => this.props.openNote(props.note.id)"
		>
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

					<t t-if="props.note.date" t-esc="props.note.date"></t>
					<t t-else="" t-esc="'Sans date'"></t>
				</p>
			</div>
			<div class="notes-item__actions">
				<button
					type="button"
					class="notes-item__action notes-item__edit"
					t-on-click.stop.prevent="() => this.props.editNote(props.note.id)"
				>
					<img src="${EditIcon}" />
				</button>
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

	static components = {};

	state: any = undefined;

	setup() {
		this.state = useState({});
	}
}
