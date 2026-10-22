import { onMounted, onPatched, onWillDestroy, useState, xml } from "@odoo/owl";

import { Capacitor } from "@capacitor/core";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Dialog } from "@capacitor/dialog";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Geolocation, PermissionStatus, Position } from "@capacitor/geolocation";
import { BiometryUtils } from "../../utils/biometryUtils";
import { WebViewUtils } from "../../utils/webViewUtils";
import { generateVideoThumbnail } from "../../utils/videoThumbnailUtils";
import { EnhancedComponent } from "../../js/enhancedComponent";
import { ErrorMessages } from "../../constants/errorMessages";
import { NoNoteEntryMatchError, NoNoteMatchError, NoteKeyNotFoundError, UndefinedNoteListError } from "../../js/errors";
import { Events } from "../../constants/events";
import { NoteEntry, NoteEntryAudioParams, NoteEntryDateParams, NoteEntryPhotoParams, NoteEntryTextParams, NoteEntryVideoParams } from "../../models/note";
import { RemoteRecordDeletedError, SyncCredentials, TASK_CREATE } from "../../services/syncService";
import {
	applyTaskTargets,
	buildTaskTargetRow,
	filteredOptions,
	loadingRow,
	needsTaskTarget,
	ProjectOption,
	TaskTargetRow,
} from "../../services/taskTargetPicker";
import { OutboxBlockedError } from "../../services/outboxService";
import { networkService } from "../../services/networkService";
import type { SyncConfig } from "../../models/syncConfig";
import { loadSyncConfigs, syncConfigIdFor } from "../../models/syncConfig";

import { DatePickerComponent } from "./date_picker/date_picker_component";
import { NoteBottomControlsComponent } from "./bottom_controls/note_bottom_controls_component";
import { NoteContentComponent } from "./content/note_content_component";
import { NoteTopControlsComponent } from "./top_controls/note_top_controls_component";
import { TagManagerComponent } from "./tag_manager/tag_manager_component";

/** One remote record of the note, offered by "Ouvrir dans l'app". */
interface OpenInAppItem {
	label: string;
	appUrl: string;
	username: string;
	password: string;
	model: string;
	resId: number;
}

export class NoteComponent extends EnhancedComponent {
	static template = xml`
		<div id="note-component">
			<div
				class="sr-only"
				aria-live="polite"
				aria-atomic="true"
				t-esc="state.syncAnnouncement"
			/>
			<nav class="breadcrumb" t-att-aria-label="t('aria.note_breadcrumb')">
				<a href="#" role="button" t-att-aria-label="t('aria.back_to_notes')" t-on-click.stop.prevent="onBackToNotesClick"><t t-esc="t('nav.notes')"/></a>
				<span class="breadcrumb__sep">›</span>
				<span class="breadcrumb__current" t-esc="state.note.title or 'Nouvelle note'"/>
				<div class="breadcrumb__note-nav">
					<button
						type="button"
						class="breadcrumb__note-nav-btn"
						t-att-aria-label="t('aria.previous_note')"
						t-att-disabled="!hasPrevious"
						t-on-click.stop.prevent="navigatePrevious"
					>‹</button>
					<button
						type="button"
						class="breadcrumb__note-nav-btn"
						t-att-aria-label="t('aria.next_note')"
						t-att-disabled="!hasNext"
						t-on-click.stop.prevent="navigateNext"
					>›</button>
					<div class="breadcrumb__sync-wrap">
						<button
							type="button"
							t-att-class="'breadcrumb__sync-btn breadcrumb__sync-btn--' + state.syncStatus + (state.isPressing ? ' breadcrumb__sync-btn--pressing' : '')"
							t-att-disabled="state.isSyncing or state.newNote"
							t-att-title="syncTitle"
							t-att-aria-label="syncTitle"
							aria-haspopup="dialog"
							t-att-aria-expanded="state.showConfigPicker ? 'true' : 'false'"
							t-on-pointerdown="onSyncPointerDown"
							t-on-pointerup="onSyncPointerUp"
							t-on-pointercancel="onSyncPointerCancel"
							t-esc="syncIcon"
						/>
						<div
							t-if="state.showConfigPicker"
							class="breadcrumb__config-picker"
							role="dialog"
							aria-modal="true"
							aria-labelledby="config-picker-title"
						>
							<p id="config-picker-title" class="breadcrumb__config-picker-label"><t t-esc="t('label.sync_with')"/></p>
							<t t-foreach="state.syncConfigs" t-as="cfg" t-key="cfg.id">
								<t t-set="row" t-value="state.taskTargets[cfg.id]"/>
								<label t-att-class="'breadcrumb__config-option' + (row and row.unusable ? ' breadcrumb__config-option--unusable' : '')">
									<input
										type="checkbox"
										t-att-checked="state.selectedConfigIds.includes(cfg.id)"
										t-att-disabled="row and row.unusable"
										t-on-change="(ev) => this.toggleConfigSelection(cfg.id, ev.target.checked)"
									/>
									<span t-esc="cfg.name or cfg.appUrl"/>
								</label>
								<p t-if="row and row.loading" class="breadcrumb__config-note"><t t-esc="t('label.sync_target_loading')"/></p>
								<p t-elif="row and row.error and !row.needsChoice" class="breadcrumb__config-note breadcrumb__config-note--warn" t-esc="row.error"/>
								<p t-elif="row and row.unusable" class="breadcrumb__config-note breadcrumb__config-note--warn" t-esc="t('label.sync_target_unusable_' + row.unusable)"/>
								<p t-elif="row and row.linkedResId" class="breadcrumb__config-note" t-esc="t('label.sync_target_linked', { id: row.linkedResId })"/>
								<div t-elif="row and row.needsChoice and state.selectedConfigIds.includes(cfg.id)" class="breadcrumb__config-project">
									<p t-if="row.reason and row.reason !== 'incomplete'" class="breadcrumb__config-note breadcrumb__config-note--warn" t-esc="t('label.sync_target_reason_' + row.reason, { id: row.deletedResId or '' })"/>
									<label class="breadcrumb__config-note" t-att-for="'sync-project-' + cfg_index"><t t-esc="t('label.sync_target_project')"/></label>
									<input
										t-if="row.options.length > 10"
										type="search"
										class="breadcrumb__config-filter"
										t-att-placeholder="t('label.sync_target_filter')"
										t-att-aria-label="t('label.sync_target_filter')"
										t-att-value="row.filter"
										t-on-input="(ev) => this.setProjectFilter(cfg.id, ev.target.value)"
									/>
									<select
										class="breadcrumb__config-select"
										t-att-id="'sync-project-' + cfg_index"
										t-on-change="(ev) => this.setProjectSelection(cfg.id, ev.target.value)"
									>
										<option value="none" t-att-selected="row.selection === 'none'"><t t-esc="t('label.sync_target_no_project')"/></option>
										<option t-if="row.canDefer" value="later" t-att-selected="row.selection === 'later'"><t t-esc="t('label.sync_target_later')"/></option>
										<t t-foreach="projectOptions(row)" t-as="opt" t-key="opt.value">
											<option t-att-value="opt.value" t-att-selected="row.selection === opt.value" t-esc="opt.name"/>
										</t>
									</select>
									<p t-if="row.offline and row.options.length === 0" class="breadcrumb__config-note"><t t-esc="t('label.sync_target_no_cache')"/></p>
									<p t-elif="row.fromCache and !row.offline" class="breadcrumb__config-note"><t t-esc="t('label.sync_target_from_cache')"/></p>
									<p t-if="row.truncated" class="breadcrumb__config-note"><t t-esc="t('label.sync_target_truncated')"/></p>
								</div>
							</t>
							<button
								type="button"
								class="breadcrumb__config-confirm"
								t-att-disabled="state.selectedConfigIds.length === 0 or pickerLoading"
								t-on-click="() => this.confirmConfigSelection()"
							><t t-esc="t('button.synchronise')"/></button>
							<button
								type="button"
								class="breadcrumb__config-cancel"
								t-on-click="cancelConfigPick"
							><t t-esc="t('button.cancel')"/></button>
						</div>
					</div>
					<div class="breadcrumb__options-wrap">
						<button
							type="button"
							class="breadcrumb__options-btn"
							t-att-disabled="state.newNote"
							t-att-title="t('nav.options')"
							t-att-aria-label="t('aria.options')"
							aria-haspopup="menu"
							t-att-aria-expanded="state.showOptionsMenu ? 'true' : 'false'"
							t-on-click.stop.prevent="toggleOptionsMenu"
						>⋮</button>
						<div
							t-if="state.showOptionsMenu"
							class="breadcrumb__options-menu"
							role="menu"
						>
							<button
								type="button"
								class="breadcrumb__options-item"
								role="menuitem"
								t-on-click.stop.prevent="onMetadataClick"
							><t t-esc="t('button.sql_metadata')"/></button>
							<button
								type="button"
								class="breadcrumb__options-item"
								role="menuitem"
								t-on-click.stop.prevent="onDebugClick"
							>🐛 <t t-esc="t('button.debug')"/></button>
						</div>
					</div>
				</div>
			</nav>
			<NoteTopControlsComponent
				note="state.note"
				toggleEditMode.bind="toggleEditMode"
				onTagsClick.bind="onTagsClick"
				onArchiveClick.bind="onArchiveClick"
				onPinClick.bind="onPinClick"
				toggleDone.bind="toggleDone"
				toggleOptionMode.bind="toggleOptionMode"
				optionMode="state.optionMode"
				syncStatus="state.syncStatus"
				syncLabel="syncLabel"
				isSyncing="state.isSyncing"
				newNote="state.newNote"
				onSyncClick.bind="pushToOdoo"
			onSyncLongPress.bind="openSyncPicker"
			onOpenInAppClick.bind="onOpenInAppClick"
			onPriorityClick.bind="onPriorityClick"
			/>
			<NoteContentComponent
				note="state.note"
				editMode="state.editMode"
				saveNoteData.bind="saveNoteData"
				addText.bind="addText"
				deleteEntry.bind="deleteEntry"
			/>
			<NoteBottomControlsComponent
				addAudio.bind="addAudio"
				addLocation.bind="addLocation"
				addText.bind="addText"
				addDateEntry.bind="addDateEntry"
				addPhoto.bind="addPhoto"
				addVideo.bind="addVideo"
				addImage.bind="addImage"
			/>
		</div>
		<DatePickerComponent
			note="state.note"
			setEntryDate.bind="setEntryDate"
		/>
		<TagManagerComponent />
		<div
			t-if="state.openInApp.visible"
			class="error-dialog-overlay"
			role="presentation"
			t-on-click.stop.prevent="closeOpenInApp"
		>
			<div
				class="error-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="open-in-app-title"
				t-on-click.stop=""
			>
				<p id="open-in-app-title" class="open-in-app__title"><t t-esc="t('button.open_in_app')"/></p>
				<div class="error-dialog__actions">
					<t t-foreach="state.openInApp.apps" t-as="appItem" t-key="appItem.appUrl + '|' + appItem.username">
						<button type="button" class="error-dialog__btn error-dialog__btn--note" t-on-click.stop.prevent="() => this.openInAppForConfig(appItem)">
							<t t-esc="appItem.label" />
						</button>
					</t>
					<button type="button" class="error-dialog__btn error-dialog__btn--close" t-on-click.stop.prevent="closeOpenInApp"><t t-esc="t('button.cancel')"/></button>
				</div>
			</div>
		</div>
		<div
			t-if="state.priorityPicker.visible"
			class="priority-picker-overlay"
			role="presentation"
			t-on-click.stop.prevent="closePriorityPicker"
		>
			<div
				class="priority-picker"
				role="dialog"
				aria-modal="true"
				aria-labelledby="priority-picker-title"
				t-on-click.stop=""
			>
				<p id="priority-picker-title" class="priority-picker__title"><t t-esc="t('section.eisenhower')"/></p>
				<div class="priority-picker__grid">
					<button type="button" class="priority-picker__btn priority-picker__btn--1" t-on-click.stop="() => this.setPriority(1)">
						<span class="priority-picker__label"><t t-esc="t('label.urgent_important')"/></span>
						<span class="priority-picker__desc"><t t-esc="t('label.do_now')"/></span>
					</button>
					<button type="button" class="priority-picker__btn priority-picker__btn--2" t-on-click.stop="() => this.setPriority(2)">
						<span class="priority-picker__label"><t t-esc="t('label.important_not_urgent')"/></span>
						<span class="priority-picker__desc"><t t-esc="t('label.schedule')"/></span>
					</button>
					<button type="button" class="priority-picker__btn priority-picker__btn--3" t-on-click.stop="() => this.setPriority(3)">
						<span class="priority-picker__label"><t t-esc="t('label.urgent_not_important')"/></span>
						<span class="priority-picker__desc"><t t-esc="t('label.delegate')"/></span>
					</button>
					<button type="button" class="priority-picker__btn priority-picker__btn--4" t-on-click.stop="() => this.setPriority(4)">
						<span class="priority-picker__label"><t t-esc="t('label.neither')"/></span>
						<span class="priority-picker__desc"><t t-esc="t('label.eliminate')"/></span>
					</button>
				</div>
				<button type="button" class="priority-picker__clear" t-on-click.stop="() => this.setPriority(undefined)"><t t-esc="t('button.clear_priority')"/></button>
				<button type="button" class="priority-picker__cancel" t-on-click.stop="closePriorityPicker"><t t-esc="t('button.cancel')"/></button>
			</div>
		</div>
		<div
			t-if="state.errorDialog.visible"
			class="error-dialog-overlay"
			role="presentation"
			t-on-click.stop.prevent="closeErrorDialog"
		>
			<div
				class="error-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="error-dialog-title"
				t-on-click.stop=""
			>
				<p id="error-dialog-title" class="sr-only"><t t-esc="t('section.error_detail')"/></p>
				<pre class="error-dialog__message" t-esc="state.errorDialog.message" />
				<div class="error-dialog__actions">
					<button type="button" class="error-dialog__btn error-dialog__btn--copy" t-on-click.stop.prevent="copyErrorMessage">📋 <t t-esc="t('button.copy')"/></button>
					<button type="button" class="error-dialog__btn error-dialog__btn--note" t-on-click.stop.prevent="createErrorNote">📝 <t t-esc="t('button.create_note')"/></button>
					<button type="button" class="error-dialog__btn error-dialog__btn--close" t-on-click.stop.prevent="closeErrorDialog"><t t-esc="t('button.close')"/></button>
				</div>
			</div>
		</div>
		<div
			t-if="state.debugDialog.visible"
			class="error-dialog-overlay"
			role="presentation"
			t-on-click.stop.prevent="closeDebugDialog"
		>
			<div class="error-dialog" role="dialog" aria-modal="true" t-on-click.stop="">
				<pre class="debug-dialog__message" t-esc="state.debugDialog.message"/>
				<div class="error-dialog__actions">
					<button type="button" class="error-dialog__btn error-dialog__btn--note" t-on-click.stop.prevent="createDebugNote">📝 <t t-esc="t('button.add_note')"/></button>
					<button type="button" class="error-dialog__btn error-dialog__btn--close" t-on-click.stop.prevent="closeDebugDialog"><t t-esc="t('button.close')"/></button>
				</div>
			</div>
		</div>
	`;

	static components = {
		DatePickerComponent,
		NoteBottomControlsComponent,
		NoteContentComponent,
		NoteTopControlsComponent,
		TagManagerComponent
	};

	/** Tracks which element had focus before a dialog was opened, so we can restore it on close. */
	private _dialogTrigger: HTMLElement | null = null;
	/** Which dialog was open on the previous render cycle (for focus-in detection). */
	private _prevDialog: string | null = null;
	/** Bound escape key handler — kept for removal on destroy. */
	private _boundEscapeHandler: ((ev: KeyboardEvent) => void) | null = null;

	setup() {
		this.state = useState({
			noteId: undefined,
			note: this.noteService.getNewNote(),
			newNote: false,
			editMode: false,
			optionMode: false,
			allNoteIds: [] as string[],
			syncStatus: "local" as string,
			syncConfigId: null as string | null,
			isSyncing: false,
			isPressing: false,
			syncConfigs: [] as SyncConfig[],
			selectedConfigIds: [] as string[],
			showConfigPicker: false,
			/** Per sync config id: what the picker shows for the note's task there. */
			taskTargets: {} as Record<string, TaskTargetRow>,
			showOptionsMenu: false,
			debugDialog: { visible: false, message: "" },
			errorDialog: { visible: false, message: "" },
			openInApp: { visible: false, apps: [] as OpenInAppItem[] },
			priorityPicker: { visible: false },
			syncAnnouncement: "",
		});
		this.setParams();
		this.getNote();
		this.loadAllNoteIds();
		this.listenForEvents();
		onMounted(() => {
			this.loadSyncStatus();
			this._boundEscapeHandler = this._onKeydownEscape.bind(this);
			document.addEventListener("keydown", this._boundEscapeHandler);
		});
		onWillDestroy(() => {
			if (this._boundEscapeHandler) {
				document.removeEventListener("keydown", this._boundEscapeHandler);
			}
		});
		onPatched(() => this._manageFocusAfterPatch());
	}

	/** Focus management: move focus into dialogs when they open; restore on close. */
	private _manageFocusAfterPatch() {
		const openDialog =
			this.state.priorityPicker.visible ? "priority" :
			this.state.errorDialog.visible    ? "error" :
			this.state.openInApp.visible      ? "openInApp" :
			this.state.showConfigPicker       ? "configPicker" :
			null;

		if (openDialog !== this._prevDialog) {
			if (openDialog) {
				// Dialog just opened — save trigger, focus first button inside dialog
				this._dialogTrigger = document.activeElement as HTMLElement | null;
				const dialogEl = document.querySelector(`[role="dialog"]`);
				if (dialogEl) {
					const first = dialogEl.querySelector<HTMLElement>("button, [href], input, [tabindex]");
					first?.focus();
				}
			} else if (this._dialogTrigger) {
				// Dialog just closed — restore focus to trigger
				this._dialogTrigger.focus();
				this._dialogTrigger = null;
			}
			this._prevDialog = openDialog;
		}
	}

	get syncIcon(): string {
		if (this.state.isSyncing) return "⟳";
		switch (this.state.syncStatus) {
			case "synced":  return "✓☁";
			case "error":   return "✗☁";
			case "pending": return "☁!";
			default:        return "☁";
		}
	}

	get syncTitle(): string {
		if (this.state.isSyncing) return "Sync en cours…";
		const cfg = this.state.syncConfigs.find((c) => c.id === this.state.syncConfigId);
		const server = cfg ? ` — ${cfg.name || cfg.appUrl}` : "";
		switch (this.state.syncStatus) {
			case "synced":  return `Synchronisé${server}`;
			case "error":   return `Erreur de sync${server}`;
			case "pending": return "Modifications en attente";
			default:        return "Pousser vers Odoo";
		}
	}

	get syncLabel(): string {
		if (this.state.isSyncing) return "Sync…";
		const cfg = this.state.syncConfigs.find((c) => c.id === this.state.syncConfigId);
		switch (this.state.syncStatus) {
			case "synced":  return cfg?.name || cfg?.appUrl || "Synchronisé";
			case "error":   return "Erreur";
			case "pending": return "En attente";
			default:        return "Synchroniser";
		}
	}

	_pressTimer: ReturnType<typeof setTimeout> | null = null;
	_pressTriggered = false;

	onSyncPointerDown(ev: PointerEvent) {
		if (this.state.isSyncing || this.state.newNote) return;
		ev.preventDefault();
		(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
		this.state.isPressing = true;
		this._pressTriggered = false;
		this._pressTimer = setTimeout(async () => {
			this._pressTriggered = true;
			this.state.isPressing = false;
			await this.openSyncPicker();
		}, 1000);
	}

	onSyncPointerUp() {
		if (this._pressTimer) { clearTimeout(this._pressTimer); this._pressTimer = null; }
		if (!this.state.isPressing) return;
		this.state.isPressing = false;
		if (!this._pressTriggered) this.pushToOdoo();
	}

	onSyncPointerCancel() {
		if (this._pressTimer) { clearTimeout(this._pressTimer); this._pressTimer = null; }
		this.state.isPressing = false;
	}

	async openSyncPicker() {
		if (this.state.showConfigPicker) return;
		const configs = await loadSyncConfigs(this.appService);
		this.state.syncConfigs = configs;
		if (configs.length === 0) {
			await Dialog.alert({ message: "Configurez la synchronisation dans les options." });
			return;
		}
		if (this.state.selectedConfigIds.length === 0) {
			this.state.selectedConfigIds = configs.map((c) => c.id);
		}
		await this.showPicker(configs);
	}

	/**
	 * Opens the picker and fills, per server, the task's state and
	 * projects. The rows are reset to "loading" before the picker shows, so
	 * Synchronise stays disabled until every selected server is known.
	 */
	private async showPicker(configs: SyncConfig[]) {
		const rows: Record<string, TaskTargetRow> = {};
		for (const cfg of configs) rows[cfg.id] = loadingRow();
		this.state.taskTargets = rows;
		this.state.showConfigPicker = true;
		await this.loadTaskTargets(configs);
	}

	/** Bumped by each loadTaskTargets: an older load's rows are dropped. */
	private _targetsLoad = 0;

	/** Whether the picker still waits for a server's task state or projects. */
	get pickerLoading(): boolean {
		return this.state.selectedConfigIds.some((id: string) => this.state.taskTargets[id]?.loading);
	}

	projectOptions(row: TaskTargetRow): ProjectOption[] {
		return filteredOptions(row);
	}

	setProjectSelection(configId: string, value: string) {
		const row = this.state.taskTargets[configId];
		if (row) row.selection = value;
	}

	setProjectFilter(configId: string, value: string) {
		const row = this.state.taskTargets[configId];
		if (row) row.filter = value;
	}

	/**
	 * Fills state.taskTargets for configs (see buildTaskTargetRow). A
	 * server that cannot receive a task, or whose state could not be read,
	 * is unselected. Rows of a load superseded by a newer one, or of a note
	 * left meanwhile, are dropped.
	 */
	private async loadTaskTargets(configs: SyncConfig[]) {
		const load = ++this._targetsLoad;
		const noteId = this.state.noteId;
		const online = await networkService.isOnline();
		await Promise.all(configs.map(async (cfg) => {
			const row = await buildTaskTargetRow(this.syncService, noteId, cfg.id, () => this.credsFor(cfg), online);
			if (load !== this._targetsLoad || this.state.noteId !== noteId) return;
			this.state.taskTargets[cfg.id] = row;
			if (row.unusable || (row.error && !row.needsChoice)) {
				this.state.selectedConfigIds = this.state.selectedConfigIds.filter((id: string) => id !== cfg.id);
			}
		}));
	}

	/** Credentials of a sync target, from its application. */
	private async credsFor(cfg: SyncConfig): Promise<SyncCredentials> {
		const apps = await this.appService.getApps();
		const app = apps.find((a) => a.url === cfg.appUrl && a.username === cfg.appUsername);
		if (!app) throw new Error("Application Odoo introuvable.");
		return {
			odooUrl: cfg.appUrl,
			username: app.username,
			password: app.password,
			database: cfg.database,
		};
	}

	/** Close whichever overlay is open when the user presses Escape. */
	private _onKeydownEscape(ev: KeyboardEvent) {
		if (ev.key !== "Escape") return;
		if (this.state.priorityPicker.visible) { ev.preventDefault(); this.closePriorityPicker(); }
		else if (this.state.errorDialog.visible) { ev.preventDefault(); this.closeErrorDialog(); }
		else if (this.state.openInApp.visible) { ev.preventDefault(); this.closeOpenInApp(); }
		else if (this.state.showConfigPicker) { ev.preventDefault(); this.cancelConfigPick(); }
		else if (this.state.showOptionsMenu) { ev.preventDefault(); this.state.showOptionsMenu = false; }
		else if (this.state.debugDialog.visible) { ev.preventDefault(); this.closeDebugDialog(); }
	}

	private announceSyncStatus(status: string, offline = false) {
		const messages: Record<string, string> = {
			synced:  "Note synchronisée.",
			error:   "Erreur de synchronisation.",
			pending: offline
				? "Synchronisation en attente — hors ligne."
				: "Synchronisation en attente.",
		};
		this.state.syncAnnouncement = messages[status] ?? "";
		// Clear after screen reader has time to read it
		setTimeout(() => { this.state.syncAnnouncement = ""; }, 3000);
	}

	async pushToOdoo() {
		if (this.state.isSyncing || this.state.newNote || this.state.showConfigPicker) return;

		// Configs are local: the server choice is made, and kept, even offline
		const configs = await loadSyncConfigs(this.appService);
		this.state.syncConfigs = configs;

		if (configs.length === 0) {
			await Dialog.alert({ message: "Configurez la synchronisation dans les options." });
			return;
		}

		// Use remembered selection if still valid, else the single config
		let selected = configs.filter((c) => this.state.selectedConfigIds.includes(c.id));
		if (selected.length === 0 && configs.length === 1) selected = [configs[0]];
		if (selected.length > 0) {
			this.state.selectedConfigIds = selected.map((c) => c.id);
			// A server where the note has no task yet: its project is chosen first
			if (await needsTaskTarget(this.syncService, this.state.noteId, selected.map((c) => c.id))) {
				await this.showPicker(configs);
				return;
			}
			await this.doPushSelected(selected);
			return;
		}

		// Multiple configs, no selection yet → show picker (pre-select all)
		this.state.selectedConfigIds = configs.map((c) => c.id);
		await this.showPicker(configs);
	}


	toggleConfigSelection(id: string, checked: boolean) {
		if (checked) {
			if (!this.state.selectedConfigIds.includes(id)) {
				this.state.selectedConfigIds = [...this.state.selectedConfigIds, id];
			}
		} else {
			this.state.selectedConfigIds = this.state.selectedConfigIds.filter((x) => x !== id);
		}
	}

	async confirmConfigSelection() {
		if (this.pickerLoading) return;
		const selected = this.state.syncConfigs.filter((c) => this.state.selectedConfigIds.includes(c.id));
		if (selected.length === 0) return;
		try {
			await applyTaskTargets(this.syncService, this.state.noteId, selected.map((c) => c.id), this.state.taskTargets);
		} catch (e: unknown) {
			this.showErrorDialog(e instanceof Error ? e.message : String(e));
			return;
		}
		this.state.showConfigPicker = false;
		await this.saveSyncSelection(this.state.selectedConfigIds);
		await this.doPushSelected(selected);
	}

	cancelConfigPick() {
		this.state.showConfigPicker = false;
	}

	/**
	 * Set by doPushCore when the user agreed to recreate a task deleted on
	 * the server: the picker opens once the push is over, to choose the
	 * project it is recreated in.
	 */
	private _pickAfterSync = false;

	private async doPushSelected(configs: SyncConfig[]) {
		if (!(await networkService.isOnline())) {
			await this.queueForReconnect(configs);
			return;
		}
		if (configs.length === 1) {
			await this.doPush(configs[0]);
		} else {
			await this.doPushAll(configs);
		}
		if (this._pickAfterSync) {
			this._pickAfterSync = false;
			await this.showPicker(this.state.syncConfigs);
		}
	}

	/** Offline: the note waits, per server, for syncAll on reconnect. */
	private async queueForReconnect(configs: SyncConfig[]) {
		// A server whose task was deleted, and no recreation chosen in the
		// picker, needs the online recreate prompt, and one whose creation is
		// blocked (ambiguous) needs the user's choice online:
		// queued, either would only wait again on reconnect. A creation left
		// "incomplete" (project to choose later) is pending: the next online
		// tap opens the picker for it
		const queued: SyncConfig[] = [];
		const deleted: SyncConfig[] = [];
		const blocked: SyncConfig[] = [];
		for (const cfg of configs) {
			const link = await this.databaseService.findNoteLink(this.state.noteId, cfg.id, "project.task", "create", true);
			const op = link?.remoteState === "ok"
				? null
				: await this.syncService.outbox.find(this.state.noteId, cfg.id, TASK_CREATE);
			if (op?.status === "blocked") blocked.push(cfg);
			else if (link?.remoteState === "deleted" && !op) deleted.push(cfg);
			else queued.push(cfg);
		}
		if (deleted.length > 0) {
			await Dialog.alert({
				title: "Tâche supprimée sur le serveur",
				message: "La tâche liée a été supprimée sur : "
					+ deleted.map((c) => c.name || c.appUrl).join(", ")
					+ ".\nSynchronisez en ligne pour la recréer.",
			});
		}
		if (blocked.length > 0) {
			await Dialog.alert({
				title: "Création en attente d'un choix",
				message: "La création de la tâche attend votre décision sur : "
					+ blocked.map((c) => c.name || c.appUrl).join(", ")
					+ ".\nSynchronisez en ligne pour la terminer.",
			});
		}
		if (queued.length === 0) return;
		await this.databaseService.markNotePendingForConfigs(this.state.noteId, queued.map((c) => c.id));
		this.state.syncStatus = "pending";
		this.announceSyncStatus("pending", true);
	}

	/** Reflects the global status pushNote derived from every server. */
	private async refreshSyncStatusFromDb(): Promise<string> {
		const { syncStatus } = await this.databaseService.getNoteSyncInfo(this.state.noteId);
		this.state.syncStatus = syncStatus;
		return syncStatus;
	}

	private async doPushCore(cfg: SyncConfig): Promise<void> {
		const creds = await this.credsFor(cfg);
		try {
			await this.syncService.pushNote(creds, this.state.noteId, { userInitiated: true });
		} catch (e: unknown) {
			// Left to choose later: the creation waits, it has not failed;
			// pending, as the same choice made offline (queueForReconnect)
			if (e instanceof OutboxBlockedError && e.reason === "incomplete") {
				await this.databaseService.markNotePendingForConfigs(this.state.noteId, [cfg.id]);
				return;
			}
			if (e instanceof OutboxBlockedError && e.reason === "ambiguous" && e.candidates.length > 0) {
				await this.resolveAmbiguousCreation(creds, e);
				return;
			}
			if (!(e instanceof RemoteRecordDeletedError)) throw e;
			// Deleted on the server: recreated only on the user's say-so, in
			// the project the picker then asks for
			const { value } = await Dialog.confirm({
				title: "Tâche supprimée sur le serveur",
				message: `${e.message}\nLa recréer à partir de cette note ? Vous choisirez son projet.`,
			});
			if (value) this._pickAfterSync = true;
		}
	}

	/**
	 * Several tasks carry this note's reference on the server: the user
	 * picks the one to link, by number, or leaves the creation blocked.
	 */
	private async resolveAmbiguousCreation(creds: SyncCredentials, e: OutboxBlockedError): Promise<void> {
		const ids = e.candidates;
		const { value, cancelled } = await Dialog.prompt({
			title: "Plusieurs tâches correspondent",
			message: `${e.message}\nNuméro de la tâche à lier à cette note (${ids.map((id) => `#${id}`).join(", ")}) :`,
			inputText: String(ids[0]),
		});
		const picked = Number(String(value ?? "").replace(/^#/, "").trim());
		if (cancelled || !ids.includes(picked)) {
			throw new Error(`Création bloquée : aucune tâche choisie parmi ${ids.map((id) => `#${id}`).join(", ")}.`);
		}
		await this.syncService.pushNote(creds, this.state.noteId, { userInitiated: true, adoptTaskId: picked });
	}

	private async doPush(cfg: SyncConfig) {
		this.state.isSyncing = true;
		try {
			await this.doPushCore(cfg);
			await this.databaseService.setNoteSyncInfo(this.state.noteId, { syncConfigId: cfg.id });
			this.state.syncConfigId = cfg.id;
			this.announceSyncStatus(await this.refreshSyncStatusFromDb());
		} catch (e: unknown) {
			await this.databaseService.setNotePerServerStatus(this.state.noteId, cfg.id, "error").catch(() => {});
			await this.databaseService.refreshNoteSyncStatus(this.state.noteId).catch(() => {});
			this.state.syncStatus = "error";
			this.announceSyncStatus("error");
			const msg = e instanceof Error ? e.message : String(e);
			this.showErrorDialog(`Erreur sync :\n${msg}`);
		} finally {
			this.state.isSyncing = false;
		}
	}

	private async doPushAll(configs: SyncConfig[]) {
		this.state.isSyncing = true;
		const errors: string[] = [];
		for (const cfg of configs) {
			try {
				await this.doPushCore(cfg);
			} catch (e: unknown) {
				await this.databaseService.setNotePerServerStatus(this.state.noteId, cfg.id, "error").catch(() => {});
				await this.databaseService.refreshNoteSyncStatus(this.state.noteId).catch(() => {});
				errors.push(`${cfg.name || cfg.appUrl}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		this.state.isSyncing = false;
		if (errors.length > 0) {
			this.state.syncStatus = "error";
			this.announceSyncStatus("error");
			const msg = errors.join("\n");
			this.showErrorDialog(`Erreurs sync :\n${msg}`);
		} else {
			this.announceSyncStatus(await this.refreshSyncStatusFromDb());
		}
	}

	// ── Error dialog ────────────────────────────────────────────────────────

	showErrorDialog(message: string) {
		this.state.errorDialog.visible = true;
		this.state.errorDialog.message = message;
	}

	closeErrorDialog() {
		this.state.errorDialog.visible = false;
		this.state.errorDialog.message = "";
	}

	async copyErrorMessage() {
		try { await navigator.clipboard.writeText(this.state.errorDialog.message); } catch { /* unavailable */ }
	}

	async createErrorNote() {
		const note = this.noteService.getNewNote(this.noteService.getNewId());
		note.title = "Erreur d'exécution";
		const entry = this.noteService.entry.getNewTextEntry();
		(entry.params as NoteEntryTextParams).text = this.state.errorDialog.message;
		note.entries = [entry];
		await this.noteService.crud.add(note);
		this.closeErrorDialog();
		this.navigate(`/note/${encodeURIComponent(note.id)}`);
	}

	toggleOptionsMenu() {
		this.state.showOptionsMenu = !this.state.showOptionsMenu;
	}

	onDebugClick() {
		this.state.showOptionsMenu = false;
		const noteTitle = this.state.note?.title || "Nouvelle note";
		this.state.debugDialog = {
			visible: true,
			message: [
				`Vue       : Notes › ${noteTitle}`,
				`Composant : note_component.ts`,
				`Route     : /note/:id`,
			].join("\n"),
		};
	}

	closeDebugDialog() {
		this.state.debugDialog.visible = false;
	}

	async createDebugNote() {
		const message = this.state.debugDialog.message;
		this.state.debugDialog.visible = false;
		const note = this.noteService.getNewNote(this.noteService.getNewId());
		note.title = "Debug";
		const entry = this.noteService.entry.getNewTextEntry();
		(entry.params as NoteEntryTextParams).text = message;
		note.entries = [entry];
		await this.noteService.crud.add(note);
		this.navigate(`/note/${encodeURIComponent(note.id)}`);
	}

	async onMetadataClick() {
		this.state.showOptionsMenu = false;
		try {
			const row = await this.databaseService.getNoteRawData(this.state.noteId);
			if (!row) {
				await Dialog.alert({ title: "Métadonnées", message: "Note introuvable en base." });
				return;
			}
			const fmt = (v: any) => {
				if (v === null || v === undefined) return "(null)";
				if (typeof v === "string" && v.length > 80) return v.slice(0, 80) + "…";
				return String(v);
			};
			const lines = [
				"── Note ──",
				`id:                      ${fmt(row.id)}`,
				`title:                   ${fmt(row.title)}`,
				`date:                    ${fmt(row.date)}`,
				`done:                    ${fmt(row.done)}`,
				`archived:                ${fmt(row.archived)}`,
				`pinned:                  ${fmt(row.pinned)}`,
				`tags:                    ${fmt(row.tags)}`,
				`entries:                 ${fmt(row.entries)}`,
				"",
				"── Synchronisation ──",
				`odoo_id:                 ${fmt(row.odoo_id)}`,
				`odoo_url:                ${fmt(row.odoo_url)}`,
				`sync_status:             ${fmt(row.sync_status)}`,
				`last_synced_at:          ${fmt(row.last_synced_at)}`,
				`sync_config_id:          ${fmt(row.sync_config_id)}`,
				`selected_sync_config_ids:${fmt(row.selected_sync_config_ids)}`,
				`sync_per_server_status:  ${fmt(row.sync_per_server_status)}`,
				"",
				"── Liens distants (note_links) ──",
				...(await this.databaseService.getNoteLinks(this.state.noteId).catch(() => []))
					.map((l) => `${l.configId} → ${l.model} #${l.resId} (${l.kind}, ${l.lastSyncedAt ?? "jamais"})`),
			];
			const message = lines.join("\n");
			try { await navigator.clipboard.writeText(message); } catch { /* clipboard unavailable */ }
			await Dialog.alert({ title: "Métadonnées SQL", message });
		} catch (e: unknown) {
			await Dialog.alert({ title: "Métadonnées", message: String(e) });
		}
	}

	// ── Priority picker ──────────────────────────────────────────────────────

	onPriorityClick() {
		this.state.priorityPicker.visible = true;
	}

	closePriorityPicker() {
		this.state.priorityPicker.visible = false;
	}

	async setPriority(p: 1 | 2 | 3 | 4 | undefined) {
		this.state.note.priority = p;
		this.state.priorityPicker.visible = false;
		await this.saveNoteData();
	}

	// ── Open in app ─────────────────────────────────────────────────────────

	closeOpenInApp() {
		this.state.openInApp.visible = false;
	}

	async onOpenInAppClick() {
		const links = (await this.databaseService.getNoteLinks(this.state.noteId))
			.filter((l) => l.kind === "create" && l.remoteState === "ok");
		if (links.length === 0) {
			await Dialog.alert({ message: "Cette note n'a pas encore été synchronisée avec une application." });
			return;
		}

		const apps = await this.appService.getApps();
		const appItems = links.flatMap((link) => {
			const app = apps.find((a) => syncConfigIdFor(a.url, a.username, a.database) === link.configId);
			if (!app) return [];
			return [{
				label: app.url, appUrl: app.url, username: app.username, password: app.password,
				model: link.model, resId: link.resId,
			}];
		});

		if (appItems.length === 0) {
			await Dialog.alert({ message: "Applications introuvables dans la liste." });
			return;
		}

		if (appItems.length === 1) {
			await this.openInAppForConfig(appItems[0]);
			return;
		}

		this.state.openInApp.apps = appItems;
		this.state.openInApp.visible = true;
	}

	async openInAppForConfig(app: OpenInAppItem) {
		this.state.openInApp.visible = false;
		const baseUrl = /^https?:\/\//i.test(app.appUrl) ? app.appUrl : "https://" + app.appUrl;
		const taskUrl = `${baseUrl}/web#id=${app.resId}&model=${encodeURIComponent(app.model)}&view_type=form`;

		const username = app.username.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const password = app.password.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

		const loginScript = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  function getElementByXPath(xpath) {
    return document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue || null;
  }
  function waitForXPathWithObserver(xpath, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const found = getElementByXPath(xpath);
      if (found) return resolve(found);
      let settled = false;
      const obs = new MutationObserver(() => {
        const el = getElementByXPath(xpath);
        if (el) { settled = true; obs.disconnect(); resolve(el); }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => { if (!settled) { obs.disconnect(); reject(new Error('Timeout: ' + xpath)); } }, timeout);
    });
  }
  function setInputValue(el, value) {
    try {
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      if (d && d.set) d.set.call(el, value); else el.value = value;
    } catch { el.value = value; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const ERR_SEL = '.alert.alert-danger';
  async function hasErrAfter(ms) { await sleep(ms); return !!document.querySelector(ERR_SEL); }
  if (window.__autoLoginSubmitted) return;
  if (await hasErrAfter(400)) return;
  try {
    const SUBMIT = "//button[@type='submit' and (contains(normalize-space(.), 'Log in') or contains(normalize-space(.), 'Se connecter') or contains(normalize-space(.), 'Connexion'))]";
    const [userEl, passEl] = await Promise.all([
      waitForXPathWithObserver("//*[@id='login']"),
      waitForXPathWithObserver("//*[@id='password']")
    ]);
    setInputValue(userEl, "${username}");
    setInputValue(passEl, "${password}");
    await sleep(250);
    if (!!document.querySelector(ERR_SEL)) return;
    const btn = await waitForXPathWithObserver(SUBMIT, 5000).catch(() => null);
    if (!btn || !!document.querySelector(ERR_SEL)) return;
    window.__autoLoginSubmitted = true;
    btn.scrollIntoView({ block: 'center' });
    await new Promise(r => requestAnimationFrame(r));
    btn.click();
  } catch(e) { console.error('[loginScript]', e); }
})();`;

		if (WebViewUtils.isMobile()) {
			WebViewUtils.openWebViewMobile({
				url: taskUrl,
				title: app.label,
				isPresentAfterPageLoad: true,
				preShowScript: WebViewUtils.safeAreaScript() + "\n" + loginScript,
				enabledSafeBottomMargin: true,
				toolbarColor: "#1a1a1a",
				toolbarTextColor: "#ffffff",
				activeNativeNavigationForWebview: true,
			});
		} else {
			WebViewUtils.openWebViewDesktop(taskUrl, loginScript);
		}
	}

	get currentIndex(): number {
		return this.state.allNoteIds.indexOf(this.state.noteId);
	}

	get hasPrevious(): boolean {
		return this.currentIndex > 0;
	}

	get hasNext(): boolean {
		const idx = this.currentIndex;
		return idx !== -1 && idx < this.state.allNoteIds.length - 1;
	}

	navigatePrevious() {
		if (!this.hasPrevious) return;
		const prevId = this.state.allNoteIds[this.currentIndex - 1];
		this.navigate(`/note/${encodeURIComponent(prevId)}`);
	}

	navigateNext() {
		if (!this.hasNext) return;
		const nextId = this.state.allNoteIds[this.currentIndex + 1];
		this.navigate(`/note/${encodeURIComponent(nextId)}`);
	}

	onBackToNotesClick() {
		this.navigate("/notes");
	}

	addAudio() {
		const newEntry = this.noteService.entry.getNewAudioEntry();
		this.state.note.entries.push(newEntry);
		this.saveNoteData();
		this.scrollToLastEntry();
	}

	addDateEntry() {
		const newEntry = this.noteService.entry.getNewDateEntry();

		const params = newEntry.params as NoteEntryDateParams;

		params.date = (new Date()).toISOString();

		const entries: Array<NoteEntry> = this.state.note.entries;

		entries.push(newEntry);
		this.saveNoteData();
		this.scrollToLastEntry();
	}

	async addLocation() {
		const permissions = await this.getGeolocationPermissions();

		if (!permissions || permissions.location === "denied") {
			return;
		}

		const currentPosition: Position = await Geolocation.getCurrentPosition();
		const newEntry = this.noteService.entry.getNewGeolocationEntry();

		newEntry.params = {
			text: "Données de géolocalisation",
			latitude: currentPosition.coords.latitude,
			longitude: currentPosition.coords.longitude,
			timestamp: currentPosition.timestamp
		};

		this.state.note.entries.push(newEntry);
		this.saveNoteData();
		this.scrollToLastEntry();
	}

	async addPhoto() {
		const newEntry = this.noteService.entry.getNewPhotoEntry();
		this.state.note.entries.push(newEntry);
		this.saveNoteData();
		this.scrollToLastEntry();
		await this.takePhoto(newEntry.id);
	}

	/** Pick an image from the device gallery (CameraSource.Photos) and
	 *  attach it to a fresh photo entry. Same shape as addPhoto but
	 *  skips the camera viewfinder — useful for a screenshot or an
	 *  image already on the phone. */
	async addImage() {
		const newEntry = this.noteService.entry.getNewPhotoEntry("gallery");
		this.state.note.entries.push(newEntry);
		this.saveNoteData();
		this.scrollToLastEntry();
		await this.pickImage(newEntry.id);
	}

	async pickImage(entryId: string) {
		try {
			const photo = await Camera.getPhoto({
				quality: 90,
				allowEditing: false,
				resultType: CameraResultType.Uri,
				source: CameraSource.Photos,
			});
			if (!photo.path) return;
			this.eventBus.trigger(Events.SET_PHOTO, { entryId, path: photo.path });
		} catch {
			// User cancelled — nothing to do
		}
	}

	addText() {
		this.state.note.entries.push(this.noteService.entry.getNewTextEntry());
		this.saveNoteData();
		this.focusLastEntry();
	}

	addVideo() {
		const newEntry = this.noteService.entry.getNewVideoEntry();
		this.state.note.entries.push(newEntry);
		this.saveNoteData();
		this.scrollToLastEntry();
		this.eventBus.trigger(Events.OPEN_CAMERA, { entryId: newEntry.id });
	}

	async deleteEntry(entryId: string) {
		const isBiometricAuthSuccessful: boolean = await BiometryUtils.authenticateIfAvailable();

		if (!isBiometricAuthSuccessful) {
			Dialog.alert({ message: ErrorMessages.BIOMETRIC_AUTH });
			return;
		}

		const entries: Array<NoteEntry> = this.state.note.entries;
		const entryIndex = entries.findIndex(entry => entry.id === entryId);

		if (entryIndex === -1) {
			Dialog.alert({ message: ErrorMessages.NO_NOTE_ENTRY_MATCH });
			return;
		}

		entries.splice(entryIndex, 1);
		this.saveNoteData();
	}

	toggleEditMode() {
		this.state.editMode = !this.state.editMode;
	}

	toggleOptionMode() {
		this.state.optionMode = !this.state.optionMode;
	}

	onTagsClick() {
		this.eventBus.trigger(Events.TAG_MANAGER, { noteId: this.state.noteId });
	}

	onArchiveClick() {
		this.state.note.archived = !this.state.note.archived;
		this.saveNoteData();
	}

	onPinClick() {
		this.state.note.pinned = !this.state.note.pinned;
		this.saveNoteData();
	}

	setEntryDate(entryId: string, date: string) {
		let entry: NoteEntry | undefined;

		try {
			entry = this.getEntry(entryId);
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
				return;
			}
		}

		if (!entry) {
			Dialog.alert({ message: ErrorMessages.NO_NOTE_ENTRY_MATCH });
			return;
		}

		if (entry.type !== "date") {
			return;
		}

		const params = entry.params as NoteEntryDateParams;

		params.date = date;
		this.saveNoteData();
	}

	toggleDone() {
		this.state.note.done = !this.state.note.done;
		this.saveNoteData();
	}

	async saveNoteData() {
		try {
			if (this.state.newNote) {
				await this.noteService.crud.add(this.state.note);
				this.state.newNote = false;
			} else {

				await this.noteService.crud.edit(this.state.noteId, this.state.note);
			}
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
				return;
			}
		}
	}

	private async saveSyncSelection(ids: string[]): Promise<void> {
		await this.databaseService.setNoteSyncInfo(this.state.noteId, { selectedSyncConfigIds: ids });
	}

	private async loadSyncStatus() {
		if (!this.state.noteId) return;
		const info = await this.databaseService.getNoteSyncInfo(this.state.noteId);
		this.state.syncStatus = info.syncStatus;
		this.state.syncConfigId = info.syncConfigId;
		this.state.syncConfigs = await loadSyncConfigs(this.appService);
		if (info.selectedSyncConfigIds && info.selectedSyncConfigIds.length > 0) {
			const validIds = info.selectedSyncConfigIds.filter((id) => this.state.syncConfigs.some((c) => c.id === id));
			if (validIds.length > 0) this.state.selectedConfigIds = validIds;
		}
	}

	private async loadAllNoteIds() {
		const notes = await this.noteService.getNotes();
		this.state.allNoteIds = notes.map(n => n.id);
	}

	private setParams() {
		const params = this.router.getRouteParams(window.location.pathname);
		this.state.noteId = decodeURIComponent(params?.get("id") || "");
	}

	private async getNote() {
		try {
			this.state.note = await this.noteService.getMatch(this.state.noteId);
		} catch (error: unknown) {
			if (error instanceof NoteKeyNotFoundError || error instanceof UndefinedNoteListError) {
				Dialog.alert({ message: error.message });
				return;
			} else if (error instanceof NoNoteMatchError && this.noteService.isValidId(this.state.noteId)) {
				this.state.newNote = true;
				this.state.note = this.noteService.getNewNote(this.state.noteId);
				this.state.note.date = (new Date()).toISOString();
			}
		}
	}

	/** Copies the fields a pull writes (see SyncService.pullTasks) into state. */
	private async reloadPulledFields() {
		const stored = await this.databaseService.getNoteById(this.state.noteId);
		if (!stored) return;
		this.state.note.title = stored.title;
		this.state.note.pinned = stored.pinned;
		this.state.note.archived = stored.archived;
		this.state.note.done = stored.done;
		await this.loadSyncStatus();
	}

	private listenForEvents() {
		const onAudio          = this.setAudioRecording.bind(this);
		const onVideo          = this.setVideoRecording.bind(this);
		const onPhoto          = this.setPhoto.bind(this);
		const onTranscription  = this.addTranscriptionText.bind(this);
		const onSetTranscript  = this.setEntryTranscription.bind(this);
		const onSetTranslation = this.setEntryTranslation.bind(this);
		const onTagsUpdated    = (e: any) => {
			if (e?.detail?.noteId === this.state.noteId) {
				this.state.note.tags = e?.detail?.tagIds ?? [];
			}
		};
		// Stream Deck remote-add: keys 1-3 fire while a note page is
		// mounted. Reuse the same handlers the bottom-controls bar
		// uses so the deck and the on-screen buttons stay equivalent.
		// A pull changed this note: take the server's fields, so the next
		// save does not write the older copy held here back over them
		const onNotePulled      = (e: any) => {
			if (e?.detail?.noteId === this.state.noteId) void this.reloadPulledFields();
		};
		const onDeckAddVideo    = () => { void this.addVideo(); };
		const onDeckAddAudio    = () => { void this.addAudio(); };
		const onDeckAddLocation = () => { void this.addLocation(); };

		this.eventBus.addEventListener(Events.SET_AUDIO_RECORDING,    onAudio);
		this.eventBus.addEventListener(Events.SET_VIDEO_RECORDING,    onVideo);
		this.eventBus.addEventListener(Events.SET_PHOTO,              onPhoto);
		this.eventBus.addEventListener(Events.ADD_TRANSCRIPTION_TEXT, onTranscription);
		this.eventBus.addEventListener(Events.SET_ENTRY_TRANSCRIPTION, onSetTranscript);
		this.eventBus.addEventListener(Events.SET_ENTRY_TRANSLATION,   onSetTranslation);
		this.eventBus.addEventListener(Events.NOTE_TAGS_UPDATED,       onTagsUpdated);
		this.eventBus.addEventListener(Events.NOTE_PULLED,             onNotePulled);
		this.eventBus.addEventListener(Events.STREAMDECK_ADD_VIDEO,    onDeckAddVideo);
		this.eventBus.addEventListener(Events.STREAMDECK_ADD_AUDIO,    onDeckAddAudio);
		this.eventBus.addEventListener(Events.STREAMDECK_ADD_LOCATION, onDeckAddLocation);

		// Tell the StreamDeckController this page is mounted so it
		// paints keys 1-3. The matching false fires on willDestroy.
		this.eventBus.trigger(Events.STREAMDECK_NOTE_PAGE_ACTIVE, { active: true });

		onWillDestroy(() => {
			this.eventBus.removeEventListener(Events.SET_AUDIO_RECORDING,    onAudio);
			this.eventBus.removeEventListener(Events.SET_VIDEO_RECORDING,    onVideo);
			this.eventBus.removeEventListener(Events.SET_PHOTO,              onPhoto);
			this.eventBus.removeEventListener(Events.ADD_TRANSCRIPTION_TEXT, onTranscription);
			this.eventBus.removeEventListener(Events.SET_ENTRY_TRANSCRIPTION, onSetTranscript);
			this.eventBus.removeEventListener(Events.SET_ENTRY_TRANSLATION,   onSetTranslation);
			this.eventBus.removeEventListener(Events.NOTE_TAGS_UPDATED,       onTagsUpdated);
			this.eventBus.removeEventListener(Events.NOTE_PULLED,             onNotePulled);
			this.eventBus.removeEventListener(Events.STREAMDECK_ADD_VIDEO,    onDeckAddVideo);
			this.eventBus.removeEventListener(Events.STREAMDECK_ADD_AUDIO,    onDeckAddAudio);
			this.eventBus.removeEventListener(Events.STREAMDECK_ADD_LOCATION, onDeckAddLocation);
			this.eventBus.trigger(Events.STREAMDECK_NOTE_PAGE_ACTIVE, { active: false });
		});
	}

	private addTranscriptionText(event: any) {
		const { afterEntryId, text } = event?.detail ?? {};
		if (!text) return;

		const entries: NoteEntry[] = this.state.note.entries;
		const newTextEntry = this.noteService.entry.getNewTextEntry();
		(newTextEntry.params as NoteEntryTextParams).text = text;

		if (afterEntryId) {
			const idx = entries.findIndex(e => e.id === afterEntryId);
			if (idx !== -1) {
				entries.splice(idx + 1, 0, newTextEntry);
				this.saveNoteData();
				return;
			}
		}
		// fallback: append at end
		entries.push(newTextEntry);
		this.saveNoteData();
	}

	private async setEntryTranscription(event: any) {
		const { entryId, text } = event?.detail ?? {};
		if (!entryId || text == null) return;

		let entry: NoteEntry | undefined;
		try {
			entry = this.getEntry(entryId);
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
			}
			return;
		}

		if (!entry || (entry.type !== "audio" && entry.type !== "video")) return;

		(entry.params as NoteEntryAudioParams | NoteEntryVideoParams).transcription = text;
		await this.saveNoteData();
		await this.getNote();
	}

	private async setEntryTranslation(event: any) {
		const { entryId, translation, targetLang, field } = event?.detail ?? {};
		if (!entryId || translation == null) return;

		let entry: NoteEntry | undefined;
		try {
			entry = this.getEntry(entryId);
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
			}
			return;
		}
		if (!entry) return;

		if (field === "text" && entry.type === "text") {
			(entry.params as NoteEntryTextParams).translation     = translation;
			(entry.params as NoteEntryTextParams).translationLang = targetLang;
		} else if (field === "transcription" && (entry.type === "audio" || entry.type === "video")) {
			(entry.params as NoteEntryAudioParams | NoteEntryVideoParams).transcriptionTranslation     = translation;
			(entry.params as NoteEntryAudioParams | NoteEntryVideoParams).transcriptionTranslationLang = targetLang;
		} else {
			return;
		}

		await this.saveNoteData();
		await this.getNote();
	}

	private async setPhoto(event: any) {
		const details = event?.detail;

		if (!details?.entryId || !details?.path) {
			return;
		}

		let entry: NoteEntry | undefined;

		try {
			entry = this.getEntry(details.entryId);
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
				return;
			}
		}

		if (!entry || entry.type !== "photo") {
			return;
		}

		const params = entry.params as NoteEntryPhotoParams;
		params.path = details.path;

		await this.saveNoteData();
		await this.getNote();
	}

	private focusLastEntry() {
		this.eventBus.trigger(Events.FOCUS_LAST_ENTRY);
	}

	private scrollToLastEntry() {
		this.eventBus.trigger(Events.SCROLL_TO_LAST_ENTRY);
	}

	private getEntry(entryId: string): NoteEntry {
		const entryIndex = this.getEntryIndex(entryId);

		if (entryIndex === -1) {
			throw new NoNoteEntryMatchError();
		}

		const entries: Array<NoteEntry> = this.state.note.entries;

		const entry: NoteEntry | undefined = entries.at(entryIndex);

		if (!entry) {
			throw new NoNoteEntryMatchError();
		}

		return entry;
	}

	private getEntryIndex(entryId: string): number {
		const entries: Array<NoteEntry> = this.state.note.entries;
		return entries.findIndex(entry => entry.id === entryId);
	}

	private async getGeolocationPermissions(): Promise<PermissionStatus | undefined> {
		let permissions: PermissionStatus | undefined;

		try {
			permissions = await Geolocation.checkPermissions();
		} catch (error: unknown) {
			if (error instanceof Error) {
				return undefined;
			}
		}

		return permissions;
	}

	private async setAudioRecording(event: any) {
		const details = event?.detail;
		
		if (!details?.entryId || !details?.path) {
			return;
		}

		let entry: NoteEntry | undefined;

		try {
			entry = this.getEntry(details.entryId);
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
				return;
			}
		}

		if (!entry) {
			Dialog.alert({ message: ErrorMessages.NO_NOTE_ENTRY_MATCH });
			return;
		}

		if (entry.type !== "audio") {
			return;
		}

		const params = entry.params as NoteEntryAudioParams;

		params.path = details.path;
		await this.saveNoteData();
		await this.getNote();
	}

	private async setVideoRecording(event: any) {
		const details = event?.detail;

		if (!details?.entryId || !details?.path) {
			return;
		}

		let entry: NoteEntry | undefined;

		try {
			entry = this.getEntry(details.entryId);
		} catch (error: unknown) {
			if (error instanceof Error) {
				Dialog.alert({ message: error.message });
				return;
			}
		}

		if (!entry) {
			Dialog.alert({ message: ErrorMessages.NO_NOTE_ENTRY_MATCH });
			return;
		}

		if (entry.type !== "video") {
			return;
		}

		const params = entry.params as NoteEntryVideoParams;

		params.path = details.path;
		params.thumbnailPath = await this.generateThumbnail(details.path);

		await this.saveNoteData();
		await this.getNote();
	}

	async takePhoto(entryId: string) {
		try {
			const { camera } = await Camera.requestPermissions({ permissions: ["camera"] });
			if (camera !== "granted") {
				Dialog.alert({ message: "Permission caméra refusée." });
				return;
			}

			const photo = await Camera.getPhoto({
				quality: 90,
				allowEditing: false,
				resultType: CameraResultType.Uri,
				source: CameraSource.Camera,
			});

			if (!photo.path) return;

			this.eventBus.trigger(Events.SET_PHOTO, { entryId, path: photo.path });
		} catch {
			// User cancelled — nothing to do
		}
	}

	private async generateThumbnail(videoPath: string): Promise<string | undefined> {
		try {
			const webUrl = Capacitor.convertFileSrc(videoPath);
			const base64 = await generateVideoThumbnail(webUrl);
			const filename = (videoPath.split("/").pop() ?? "video.mp4").replace(/\.[^.]+$/, ".jpg");
			const result = await Filesystem.writeFile({
				path: filename,
				data: base64,
				directory: Directory.External,
			});
			return result.uri;
		} catch {
			return undefined;
		}
	}
}
