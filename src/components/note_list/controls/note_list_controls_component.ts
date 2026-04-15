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
		<section id="notes__controls" t-att-aria-label="t('aria.list_controls')">
			<a
				class="notes__control notes__control__edit-mode"
				t-att-class="{
					'notes__control__show-archived--true': props.showArchivedNotes,
					'notes__control__show-archived--false': !props.showArchivedNotes
				}"
				href="#"
				role="button"
				t-att-aria-label="t('button.edit_mode')"
				t-att-aria-pressed="props.editMode ? 'true' : 'false'"
				t-on-click.stop.prevent="props.onToggleEditModeClick"
			>
				<p t-esc="t('button.edit_mode')"/>
			</a>
			<a
				class="notes__control notes__control__show-archived"
				t-att-class="{
					'notes__control__show-archived--true': props.showArchivedNotes,
					'notes__control__show-archived--false': !props.showArchivedNotes
				}"
				href="#"
				role="button"
				t-att-aria-label="t('button.show_archived')"
				t-att-aria-pressed="props.showArchivedNotes ? 'true' : 'false'"
				t-on-click.stop.prevent="props.onToggleNoteListClick"
			>
				<p t-esc="t('button.show_archived')"/>
				<div
					id="notes__control__show-archived__indicator"
					aria-hidden="true"
					t-att-class="{
						active: props.showArchivedNotes
					}"
				>
					<div class="pill"></div>
				</div>
			</a>
			<a
				class="notes__control notes__control__sort-priority"
				href="#"
				role="button"
				t-att-aria-label="t('button.sort_by_priority')"
				t-att-aria-pressed="props.sortByPriority ? 'true' : 'false'"
				t-on-click.stop.prevent="props.onToggleSortClick"
			>
				<p t-esc="t('button.sort_by_priority')"/>
				<div
					class="notes__control__sort-priority__indicator"
					aria-hidden="true"
					t-att-class="{
						active: props.sortByPriority
					}"
				>
					<div class="pill"></div>
				</div>
			</a>
		</section>
	`;
}
