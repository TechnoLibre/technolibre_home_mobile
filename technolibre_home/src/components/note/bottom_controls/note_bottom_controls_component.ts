import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";

import ArchiveNoteIcon from "../../../assets/icon/note_archive.svg";
import CheckBoxIcon from "../../../assets/icon/check_box.svg";
import CheckBoxBlankIcon from "../../../assets/icon/check_box_blank.svg";
import EditNoteIcon from "../../../assets/icon/note_edit.svg";
import OptionNoteIcon from "../../../assets/icon/options-vertical-svgrepo-com.svg";
import PinNoteIcon from "../../../assets/icon/pin.svg";
import TagIcon from "../../../assets/icon/tag.svg";

export class NoteBottomControlsComponent extends EnhancedComponent {
	static template = xml`
		<div id="note__bottom-controls__wrapper">
			<section
				id="note__bottom-controls"
				t-att-class="{
					'options--active': props.optionMode
				}"
			>
				<a
					id="note__control__edit"
					class="note__control"
					href="#"
					t-on-click.stop.prevent="props.toggleEditMode"
				>
					<img src="${EditNoteIcon}" />
					<p>Edit Mode</p>
				</a>
				<a
					id="note__control__option"
					class="note__control"
					href="#"
					t-on-click.stop.prevent="props.toggleOptionMode"
				>
					<img src="${OptionNoteIcon}" />
				</a>
				<a
					id="note__control__tags"
					class="note__control"
					href="#"
					t-on-click.stop.prevent="props.onTagsClick"
					t-if="props.optionMode"
				>
					<img src="${TagIcon}" />
					<p>Tags</p>
				</a>
				<a
					id="note__control__archive"
					class="note__control"
					t-att-class="{
						'note__control__archive--active': props.note.archived
					}"
					href="#"
					t-on-click.stop.prevent="props.onArchiveClick"
					t-if="props.optionMode"
				>
					<img src="${ArchiveNoteIcon}" />
					<p t-if="props.note.archived">Unarchive</p>
					<p t-else="">Archive</p>
				</a>
				<a
					id="note__control__pin"
					class="note__control"
					t-att-class="{
						'note__control__pin--active': props.note.pinned
					}"
					href="#"
					t-on-click.stop.prevent="props.onPinClick"
					t-if="props.optionMode"
				>
					<img src="${PinNoteIcon}" />
					<p t-if="props.note.pinned">Unpin</p>
					<p t-else="">Pin</p>
				</a>
				<a
					id="note__control__done"
					class="note__control"
					t-att-class="{
						'note__control__done--active': props.note.done
					}"
					href="#"
					t-on-click.stop.prevent="props.toggleDone"
					t-if="props.optionMode"
				>
					<img src="${CheckBoxIcon}" t-if="props.note.done" />
					<img src="${CheckBoxBlankIcon}" t-else="" />
					<p>Done</p>
				</a>
			</section>
		</div>
	`;
}
