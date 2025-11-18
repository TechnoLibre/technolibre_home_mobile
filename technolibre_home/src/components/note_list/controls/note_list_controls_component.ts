import { xml } from "@odoo/owl";
import { EnhancedComponent } from "../../../js/enhancedComponent";

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
				<p>Montrer les notes archivées</p>
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
