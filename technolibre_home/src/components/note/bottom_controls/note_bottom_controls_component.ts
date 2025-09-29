import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";

import ArchiveNoteIcon from "../../../assets/icon/note_archive.svg";
import CheckBoxIcon from "../../../assets/icon/check_box.svg";
import CheckBoxBlankIcon from "../../../assets/icon/check_box_blank.svg";
import EditDateIcon from "../../../assets/icon/date_edit.svg";
import PinNoteIcon from "../../../assets/icon/pin.svg";
import TagIcon from "../../../assets/icon/tag.svg";

export class NoteBottomControlsComponent extends EnhancedComponent {
	static template = xml`
		<div id="note__bottom-controls__wrapper">
			<section id="note__bottom-controls">
				<a
					id="note__control__date"
					class="note__control"
					href="#"
					t-on-click.stop.prevent="props.onSetDateClick"
				>
					<img src="${EditDateIcon}" />
					<p>Set Date</p>
				</a>
				<a
					id="note__control__tags"
					class="note__control"
					href="#"
					t-on-click.stop.prevent="props.onTagsClick"
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
				>
					<img src="${PinNoteIcon}" />
					<p t-if="props.note.pinned">Unpin</p>
					<p t-else="">Pin</p>
				</a>
				<a
					id="note__control__done"
					class="note__control"
					href="#"
					t-on-click.stop.prevent="props.toggleDone"
				>
					<img src="${CheckBoxIcon}" t-if="props.note.done" />
					<img src="${CheckBoxBlankIcon}" t-else="" />
					<p>Done</p>
				</a>
			</section>
		</div>
	`;
}
