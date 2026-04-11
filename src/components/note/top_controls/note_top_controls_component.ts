import {useState, xml} from "@odoo/owl";

import {EnhancedComponent} from "../../../js/enhancedComponent";

import ArchiveNoteIcon from "../../../assets/icon/note_archive.svg";
import CheckBoxIcon from "../../../assets/icon/check_box.svg";
import CheckBoxBlankIcon from "../../../assets/icon/check_box_blank.svg";
import CloudSyncIcon from "../../../assets/icon/cloud_sync.svg";
import EditNoteIcon from "../../../assets/icon/note_edit.svg";
import OptionNoteIcon from "../../../assets/icon/options-vertical-svgrepo-com.svg";
import PinNoteIcon from "../../../assets/icon/pin.svg";
import TagIcon from "../../../assets/icon/tag.svg";

export class NoteTopControlsComponent extends EnhancedComponent {
	state: any;
	_pressTimer: ReturnType<typeof setTimeout> | null = null;

	setup() {
		this.state = useState({ isPressing: false });
	}

	onSyncPointerDown(ev: PointerEvent) {
		if (this.props.isSyncing || this.props.newNote) return;
		ev.preventDefault();
		(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
		this.state.isPressing = true;
		this._pressTimer = setTimeout(async () => {
			this._pressTimer = null;
			this.state.isPressing = false;
			await (this.props.onSyncLongPress as () => Promise<void>)();
		}, 1000);
	}

	onSyncPointerUp() {
		if (this._pressTimer) { clearTimeout(this._pressTimer); this._pressTimer = null; }
		if (!this.state.isPressing) return;
		this.state.isPressing = false;
		(this.props.onSyncClick as () => void)();
	}

	onSyncPointerCancel() {
		if (this._pressTimer) { clearTimeout(this._pressTimer); this._pressTimer = null; }
		this.state.isPressing = false;
	}

	static template = xml`
<div id="note__top-controls__wrapper">
	<section id="note__top-controls" 
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
			id="note__control__sync"
			t-att-class="'note__control note__control__sync--' + props.syncStatus + (state.isPressing ? ' note__control__sync--pressing' : '')"
			t-att-aria-disabled="props.isSyncing or props.newNote"
			t-on-pointerdown.stop.prevent="onSyncPointerDown"
			t-on-pointerup.stop.prevent="onSyncPointerUp"
			t-on-pointercancel="onSyncPointerCancel"
			t-on-contextmenu.stop.prevent=""
		>
			<img src="${CloudSyncIcon}" />
			<p t-esc="props.syncLabel" />
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
		<a
			id="note__control__open-in-app"
			class="note__control"
			href="#"
			t-on-click.stop.prevent="props.onOpenInAppClick"
			t-if="props.optionMode"
		>
			<p>Ouvrir dans app</p>
		</a>
		<a
			id="note__control__priority"
			class="note__control"
			t-att-class="{
				'note__control__priority--1': props.note.priority === 1,
				'note__control__priority--2': props.note.priority === 2,
				'note__control__priority--3': props.note.priority === 3,
				'note__control__priority--4': props.note.priority === 4,
			}"
			href="#"
			t-on-click.stop.prevent="props.onPriorityClick"
			t-if="props.optionMode"
		>
			<p>
				Priorité
				<t t-if="props.note.priority"> (P<t t-esc="props.note.priority"/>)</t>
			</p>
		</a>
	</section>
</div>
	`;
}
