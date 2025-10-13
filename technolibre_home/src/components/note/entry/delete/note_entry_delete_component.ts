import { xml } from "@odoo/owl";

import { ConfirmResult, Dialog } from "@capacitor/dialog";
import { EnhancedComponent } from "../../../../js/enhancedComponent";

import DeleteIcon from "../../../../assets/icon/delete.svg";

export class NoteEntryDeleteComponent extends EnhancedComponent {
	static template = xml`
		<div
			class="note-entry-delete-component"
			t-att-class="{
				'active': props.editMode
			}"
		>
			<button
				class="note-entry__delete"
				t-on-click.stop.prevent="onNoteEntryDeleteClick"
			>
				<img src="${DeleteIcon}" />
			</button>
		</div>
	`;

	async onNoteEntryDeleteClick() {
		const confirm: ConfirmResult = await Dialog.confirm({ message: "Supprimer cette entrée de note?" });
		if (confirm.value) {
			this.props.deleteEntry(this.props.id);
		}
	}
}
