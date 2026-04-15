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
			role="button"
			t-att-aria-label="t('button.edit_mode')"
			t-on-click.stop.prevent="props.toggleEditMode"
		>
			<img src="${EditNoteIcon}" alt="" aria-hidden="true"/>
			<p t-esc="t('button.edit_mode')"/>
		</a>
		<a
			id="note__control__sync"
			t-att-class="'note__control note__control__sync--' + props.syncStatus + (state.isPressing ? ' note__control__sync--pressing' : '')"
			role="button"
			t-att-aria-disabled="props.isSyncing or props.newNote"
			t-att-aria-label="props.syncLabel"
			t-on-pointerdown.stop.prevent="onSyncPointerDown"
			t-on-pointerup.stop.prevent="onSyncPointerUp"
			t-on-pointercancel="onSyncPointerCancel"
			t-on-contextmenu.stop.prevent=""
		>
			<img src="${CloudSyncIcon}" alt="" aria-hidden="true"/>
			<p t-esc="props.syncLabel" />
		</a>
		<a
			id="note__control__option"
			class="note__control"
			href="#"
			role="button"
			t-att-aria-label="t('aria.note_options')"
			t-att-aria-expanded="props.optionMode ? 'true' : 'false'"
			t-on-click.stop.prevent="props.toggleOptionMode"
		>
			<img src="${OptionNoteIcon}" alt="" aria-hidden="true"/>
		</a>
		<a
			id="note__control__tags"
			class="note__control"
			href="#"
			role="button"
			t-att-aria-label="t('button.tags_open')"
			t-on-click.stop.prevent="props.onTagsClick"
			t-if="props.optionMode"
		>
			<img src="${TagIcon}" alt="" aria-hidden="true"/>
			<p t-esc="t('label.tags')"/>
		</a>
		<a
			id="note__control__archive"
			class="note__control"
			t-att-class="{
				'note__control__archive--active': props.note.archived
			}"
			href="#"
			role="button"
			t-att-aria-label="props.note.archived ? t('button.unarchive') : t('button.archive')"
			t-on-click.stop.prevent="props.onArchiveClick"
			t-if="props.optionMode"
		>
			<img src="${ArchiveNoteIcon}" alt="" aria-hidden="true"/>
			<p t-if="props.note.archived" t-esc="t('button.unarchive')"/>
			<p t-else="" t-esc="t('button.archive')"/>
		</a>
		<a
			id="note__control__pin"
			class="note__control"
			t-att-class="{
				'note__control__pin--active': props.note.pinned
			}"
			href="#"
			role="button"
			t-att-aria-label="props.note.pinned ? t('button.unpin') : t('button.pin')"
			t-on-click.stop.prevent="props.onPinClick"
			t-if="props.optionMode"
		>
			<img src="${PinNoteIcon}" alt="" aria-hidden="true"/>
			<p t-if="props.note.pinned" t-esc="t('button.unpin')"/>
			<p t-else="" t-esc="t('button.pin')"/>
		</a>
		<a
			id="note__control__done"
			class="note__control"
			t-att-class="{
				'note__control__done--active': props.note.done
			}"
			href="#"
			role="button"
			t-att-aria-label="props.note.done ? t('button.mark_not_done') : t('button.mark_done')"
			t-on-click.stop.prevent="props.toggleDone"
			t-if="props.optionMode"
		>
			<img src="${CheckBoxIcon}" t-if="props.note.done" alt="" aria-hidden="true"/>
			<img src="${CheckBoxBlankIcon}" t-else="" alt="" aria-hidden="true"/>
			<p t-esc="t('label.done')"/>
		</a>
		<a
			id="note__control__open-in-app"
			class="note__control"
			href="#"
			role="button"
			t-att-aria-label="t('button.open_in_app_long')"
			t-on-click.stop.prevent="props.onOpenInAppClick"
			t-if="props.optionMode"
		>
			<p t-esc="t('button.open_in_app')"/>
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
			role="button"
			t-att-aria-label="t('label.priority')"
			t-on-click.stop.prevent="props.onPriorityClick"
			t-if="props.optionMode"
		>
			<p>
				<t t-esc="t('label.priority')"/>
				<t t-if="props.note.priority"> (P<t t-esc="props.note.priority"/>)</t>
			</p>
		</a>
	</section>
</div>
	`;
}
