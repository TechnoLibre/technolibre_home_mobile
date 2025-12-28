import { xml } from "@odoo/owl";
import { EnhancedComponent } from "../../../js/enhancedComponent";

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

export class NoteListControlsComponent extends EnhancedComponent {
	static template = xml`
		<section id="notes__controls">
			<a
				class="notes__control notes__control__edit-mode"
				t-att-class="{
					'notes__control__show-archived--true': props.showArchivedNotes,
					'notes__control__show-archived--false': !props.showArchivedNotes
				}"
				href="#"
				t-on-click.stop.prevent="props.onToggleEditModeClick"
			>
				<p>Edit mode</p>
			</a>
			<a
				class="notes__control notes__control__show-archived"
				t-att-class="{
					'notes__control__show-archived--true': props.showArchivedNotes,
					'notes__control__show-archived--false': !props.showArchivedNotes
				}"
				href="#"
				t-on-click.stop.prevent="props.onToggleNoteListClick"
			>
				<p>Montrer les ${ENV.LABEL_NOTE}s archivées</p>
				<div
					id="notes__control__show-archived__indicator"
					t-att-class="{
						active: props.showArchivedNotes
					}"
				>
					<div class="pill"></div>
				</div>
			</a>
		</section>
	`;
}
