import { xml } from "@odoo/owl";

import { ConfirmResult, Dialog } from "@capacitor/dialog";
import { EnhancedComponent } from "../../../js/enhancedComponent";

// @ts-ignore
import DeleteIcon from "../../../assets/icon/delete.svg";

const ENV = {
    // @ts-ignore
    TITLE: import.meta.env.VITE_TITLE ?? "TITLE",
    // @ts-ignore
    LABEL_NOTE: import.meta.env.VITE_LABEL_NOTE ?? "Note",
    // @ts-ignore
    LOGO_KEY: import.meta.env.VITE_LOGO_KEY ?? "techno",
    // @ts-ignore
    WEBSITE_URL: import.meta.env.VITE_WEBSITE_URL ?? "https://erplibre.ca",
    // @ts-ignore
    DEBUG_DEV: import.meta.env.VITE_DEBUG_DEV === "true",
};

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
		const confirm: ConfirmResult = await Dialog.confirm({ message: `Supprimer cette entrée de ${ENV.LABEL_NOTE}?` });
		if (confirm.value) {
			this.props.deleteEntry(this.props.id);
		}
	}
}
