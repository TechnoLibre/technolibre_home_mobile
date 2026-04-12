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
import { SyncCredentials } from "../../services/syncService";
import type { SyncConfig } from "../../models/syncConfig";
import { loadSyncConfigs } from "../../models/syncConfig";

import { DatePickerComponent } from "./date_picker/date_picker_component";
import { NoteBottomControlsComponent } from "./bottom_controls/note_bottom_controls_component";
import { NoteContentComponent } from "./content/note_content_component";
import { NoteTopControlsComponent } from "./top_controls/note_top_controls_component";
import { TagManagerComponent } from "./tag_manager/tag_manager_component";

export class NoteComponent extends EnhancedComponent {
	static template = xml`
		<div id="note-component">
			<div
				class="sr-only"
				aria-live="polite"
				aria-atomic="true"
				t-esc="state.syncAnnouncement"
			/>
			<nav class="breadcrumb" aria-label="Fil d'ariane de la note">
				<a href="#" role="button" aria-label="Retour à la liste des notes" t-on-click.stop.prevent="onBackToNotesClick">Notes</a>
				<span class="breadcrumb__sep">›</span>
				<span class="breadcrumb__current" t-esc="state.note.title or 'Nouvelle note'"/>
				<div class="breadcrumb__note-nav">
					<button
						type="button"
						class="breadcrumb__note-nav-btn"
						aria-label="Note précédente"
						t-att-disabled="!hasPrevious"
						t-on-click.stop.prevent="navigatePrevious"
					>‹</button>
					<button
						type="button"
						class="breadcrumb__note-nav-btn"
						aria-label="Note suivante"
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
							<p id="config-picker-title" class="breadcrumb__config-picker-label">Synchroniser avec :</p>
							<t t-foreach="state.syncConfigs" t-as="cfg" t-key="cfg.id">
								<label class="breadcrumb__config-option">
									<input
										type="checkbox"
										t-att-checked="state.selectedConfigIds.includes(cfg.id)"
										t-on-change="(ev) => this.toggleConfigSelection(cfg.id, ev.target.checked)"
									/>
									<span t-esc="cfg.name or cfg.appUrl"/>
								</label>
							</t>
							<button
								type="button"
								class="breadcrumb__config-confirm"
								t-att-disabled="state.selectedConfigIds.length === 0"
								t-on-click="() => this.confirmConfigSelection()"
							>Synchroniser</button>
							<button
								type="button"
								class="breadcrumb__config-cancel"
								t-on-click="cancelConfigPick"
							>Annuler</button>
						</div>
					</div>
					<button
						type="button"
						class="breadcrumb__meta-btn"
						t-att-disabled="state.newNote"
						title="Métadonnées SQL"
						aria-label="Métadonnées SQL"
						t-on-click.stop.prevent="onMetadataClick"
					>ℹ</button>
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
				<p id="open-in-app-title" class="open-in-app__title">Ouvrir dans application</p>
				<div class="error-dialog__actions">
					<t t-foreach="state.openInApp.apps" t-as="appItem" t-key="appItem.appUrl + '|' + appItem.username">
						<button type="button" class="error-dialog__btn error-dialog__btn--note" t-on-click.stop.prevent="() => this.openInAppForConfig(appItem)">
							<t t-esc="appItem.label" />
						</button>
					</t>
					<button type="button" class="error-dialog__btn error-dialog__btn--close" t-on-click.stop.prevent="closeOpenInApp">Annuler</button>
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
				<p id="priority-picker-title" class="priority-picker__title">Priorité (Matrice d'Eisenhower)</p>
				<div class="priority-picker__grid">
					<button type="button" class="priority-picker__btn priority-picker__btn--1" t-on-click.stop="() => this.setPriority(1)">
						<span class="priority-picker__label">Urgent &amp; Important</span>
						<span class="priority-picker__desc">Faire maintenant</span>
					</button>
					<button type="button" class="priority-picker__btn priority-picker__btn--2" t-on-click.stop="() => this.setPriority(2)">
						<span class="priority-picker__label">Important, pas urgent</span>
						<span class="priority-picker__desc">Planifier</span>
					</button>
					<button type="button" class="priority-picker__btn priority-picker__btn--3" t-on-click.stop="() => this.setPriority(3)">
						<span class="priority-picker__label">Urgent, pas important</span>
						<span class="priority-picker__desc">Déléguer</span>
					</button>
					<button type="button" class="priority-picker__btn priority-picker__btn--4" t-on-click.stop="() => this.setPriority(4)">
						<span class="priority-picker__label">Ni urgent ni important</span>
						<span class="priority-picker__desc">Éliminer</span>
					</button>
				</div>
				<button type="button" class="priority-picker__clear" t-on-click.stop="() => this.setPriority(undefined)">Retirer la priorité</button>
				<button type="button" class="priority-picker__cancel" t-on-click.stop="closePriorityPicker">Annuler</button>
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
				<p id="error-dialog-title" class="sr-only">Détail de l'erreur</p>
				<pre class="error-dialog__message" t-esc="state.errorDialog.message" />
				<div class="error-dialog__actions">
					<button type="button" class="error-dialog__btn error-dialog__btn--copy" t-on-click.stop.prevent="copyErrorMessage">📋 Copier</button>
					<button type="button" class="error-dialog__btn error-dialog__btn--note" t-on-click.stop.prevent="createErrorNote">📝 Créer note</button>
					<button type="button" class="error-dialog__btn error-dialog__btn--close" t-on-click.stop.prevent="closeErrorDialog">Fermer</button>
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
			errorDialog: { visible: false, message: "" },
			openInApp: { visible: false, apps: [] as Array<{ label: string; appUrl: string; username: string; password: string; odooId: number }> },
			priorityPicker: { visible: false },
			syncAnnouncement: "",
		});
		this.setParams();
		this.getNote();
		this.loadAllNoteIds();
		this.listenForEvents();
		onMounted(() => this.loadSyncStatus());
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
		const configs = await loadSyncConfigs(this.appService);
		this.state.syncConfigs = configs;
		if (configs.length === 0) {
			await Dialog.alert({ message: "Configurez la synchronisation dans les options." });
			return;
		}
		if (this.state.selectedConfigIds.length === 0) {
			this.state.selectedConfigIds = configs.map((c) => c.id);
		}
		this.state.showConfigPicker = true;
	}

	private announceSyncStatus(status: string) {
		const messages: Record<string, string> = {
			synced:  "Note synchronisée.",
			error:   "Erreur de synchronisation.",
			pending: "Synchronisation en attente — hors ligne.",
		};
		this.state.syncAnnouncement = messages[status] ?? "";
		// Clear after screen reader has time to read it
		setTimeout(() => { this.state.syncAnnouncement = ""; }, 3000);
	}

	async pushToOdoo() {
		if (this.state.isSyncing || this.state.newNote) return;

		if (!navigator.onLine) {
			await this.databaseService.setNoteSyncInfo(this.state.noteId, { syncStatus: "pending" });
			this.state.syncStatus = "pending";
			this.announceSyncStatus("pending");
			return;
		}

		const configs = await loadSyncConfigs(this.appService);
		this.state.syncConfigs = configs;

		if (configs.length === 0) {
			await Dialog.alert({ message: "Configurez la synchronisation dans les options." });
			return;
		}

		// Use remembered selection if still valid
		const selected = configs.filter((c) => this.state.selectedConfigIds.includes(c.id));
		if (selected.length > 0) {
			await this.doPushSelected(selected);
			return;
		}

		// Single config → auto-push
		if (configs.length === 1) {
			this.state.selectedConfigIds = [configs[0].id];
			await this.doPushSelected([configs[0]]);
			return;
		}

		// Multiple configs, no selection yet → show picker (pre-select all)
		this.state.selectedConfigIds = configs.map((c) => c.id);
		this.state.showConfigPicker = true;
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
		this.state.showConfigPicker = false;
		const selected = this.state.syncConfigs.filter((c) => this.state.selectedConfigIds.includes(c.id));
		if (selected.length === 0) return;
		await this.saveSyncSelection(this.state.selectedConfigIds);
		await this.doPushSelected(selected);
	}

	cancelConfigPick() {
		this.state.showConfigPicker = false;
	}

	private async doPushSelected(configs: SyncConfig[]) {
		if (configs.length === 1) {
			await this.doPush(configs[0]);
		} else {
			await this.doPushAll(configs);
		}
	}

	private async doPushCore(cfg: SyncConfig): Promise<void> {
		const apps = await this.appService.getApps();
		const app = apps.find((a) => a.url === cfg.appUrl && a.username === cfg.appUsername);
		if (!app) throw new Error("Application Odoo introuvable.");
		const creds: SyncCredentials = {
			odooUrl: cfg.appUrl,
			username: app.username,
			password: app.password,
			database: cfg.database,
		};
		await this.syncService.pushNote(creds, this.state.noteId);
	}

	private async doPush(cfg: SyncConfig) {
		this.state.isSyncing = true;
		try {
			await this.doPushCore(cfg);
			await this.databaseService.setNoteSyncInfo(this.state.noteId, { syncConfigId: cfg.id });
			this.state.syncConfigId = cfg.id;
			this.state.syncStatus = "synced";
			this.announceSyncStatus("synced");
		} catch (e: unknown) {
			this.state.syncStatus = "error";
			this.announceSyncStatus("error");
			await this.databaseService.setNotePerServerStatus(this.state.noteId, cfg.id, "error").catch(() => {});
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
			this.state.syncStatus = "synced";
			this.announceSyncStatus("synced");
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

	async onMetadataClick() {
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
		const row = await this.databaseService.getNoteRawData(this.state.noteId);
		if (!row || !row.odoo_id) {
			await Dialog.alert({ message: "Cette note n'a pas encore été synchronisée avec une application." });
			return;
		}

		let perServerStatus: Record<string, string> = {};
		try {
			if (row.sync_per_server_status) {
				perServerStatus = JSON.parse(row.sync_per_server_status);
			}
		} catch { /* ignore */ }

		const syncedConfigIds = Object.entries(perServerStatus)
			.filter(([, status]) => status === "synced")
			.map(([id]) => id);

		if (syncedConfigIds.length === 0) {
			await Dialog.alert({ message: "Aucune application n'a synchronisé cette note avec succès." });
			return;
		}

		const apps = await this.appService.getApps();
		const appItems = syncedConfigIds.flatMap((configId) => {
			const sepIdx = configId.lastIndexOf("|");
			if (sepIdx === -1) return [];
			const url = configId.slice(0, sepIdx);
			const username = configId.slice(sepIdx + 1);
			const app = apps.find((a) => a.url === url && a.username === username);
			if (!app) return [];
			return [{ label: app.url, appUrl: app.url, username: app.username, password: app.password, odooId: row.odoo_id as number }];
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

	async openInAppForConfig(app: { label: string; appUrl: string; username: string; password: string; odooId: number }) {
		this.state.openInApp.visible = false;
		const baseUrl = /^https?:\/\//i.test(app.appUrl) ? app.appUrl : "https://" + app.appUrl;
		const taskUrl = `${baseUrl}/web#id=${app.odooId}&model=project.task&view_type=form`;

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

	private listenForEvents() {
		const onAudio          = this.setAudioRecording.bind(this);
		const onVideo          = this.setVideoRecording.bind(this);
		const onPhoto          = this.setPhoto.bind(this);
		const onTranscription  = this.addTranscriptionText.bind(this);
		const onSetTranscript  = this.setEntryTranscription.bind(this);
		const onTagsUpdated    = (e: any) => {
			if (e?.detail?.noteId === this.state.noteId) {
				this.state.note.tags = e?.detail?.tagIds ?? [];
			}
		};
		this.eventBus.addEventListener(Events.SET_AUDIO_RECORDING,    onAudio);
		this.eventBus.addEventListener(Events.SET_VIDEO_RECORDING,    onVideo);
		this.eventBus.addEventListener(Events.SET_PHOTO,              onPhoto);
		this.eventBus.addEventListener(Events.ADD_TRANSCRIPTION_TEXT, onTranscription);
		this.eventBus.addEventListener(Events.SET_ENTRY_TRANSCRIPTION, onSetTranscript);
		this.eventBus.addEventListener(Events.NOTE_TAGS_UPDATED,       onTagsUpdated);
		onWillDestroy(() => {
			this.eventBus.removeEventListener(Events.SET_AUDIO_RECORDING,    onAudio);
			this.eventBus.removeEventListener(Events.SET_VIDEO_RECORDING,    onVideo);
			this.eventBus.removeEventListener(Events.SET_PHOTO,              onPhoto);
			this.eventBus.removeEventListener(Events.ADD_TRANSCRIPTION_TEXT, onTranscription);
			this.eventBus.removeEventListener(Events.SET_ENTRY_TRANSCRIPTION, onSetTranscript);
			this.eventBus.removeEventListener(Events.NOTE_TAGS_UPDATED,       onTagsUpdated);
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
