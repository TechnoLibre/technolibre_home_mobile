import { onMounted, onWillDestroy, useState, xml } from "@odoo/owl";

import { Capacitor } from "@capacitor/core";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Dialog } from "@capacitor/dialog";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Geolocation, PermissionStatus, Position } from "@capacitor/geolocation";
import { BiometryUtils } from "../../utils/biometryUtils";
import { generateVideoThumbnail } from "../../utils/videoThumbnailUtils";
import { EnhancedComponent } from "../../js/enhancedComponent";
import { ErrorMessages } from "../../constants/errorMessages";
import { NoNoteEntryMatchError, NoNoteMatchError, NoteKeyNotFoundError, UndefinedNoteListError } from "../../js/errors";
import { Events } from "../../constants/events";
import { NoteEntry, NoteEntryAudioParams, NoteEntryDateParams, NoteEntryPhotoParams, NoteEntryVideoParams } from "../../models/note";
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
			<nav class="breadcrumb">
				<a href="#" t-on-click.stop.prevent="onBackToNotesClick">Notes</a>
				<span class="breadcrumb__sep">›</span>
				<span class="breadcrumb__current" t-esc="state.note.title or 'Nouvelle note'"/>
				<div class="breadcrumb__note-nav">
					<button
						type="button"
						class="breadcrumb__note-nav-btn"
						t-att-disabled="!hasPrevious"
						t-on-click.stop.prevent="navigatePrevious"
					>‹</button>
					<button
						type="button"
						class="breadcrumb__note-nav-btn"
						t-att-disabled="!hasNext"
						t-on-click.stop.prevent="navigateNext"
					>›</button>
					<div class="breadcrumb__sync-wrap">
						<button
							type="button"
							t-att-class="'breadcrumb__sync-btn breadcrumb__sync-btn--' + state.syncStatus + (state.isPressing ? ' breadcrumb__sync-btn--pressing' : '')"
							t-att-disabled="state.isSyncing or state.newNote"
							t-att-title="syncTitle"
							t-on-pointerdown="onSyncPointerDown"
							t-on-pointerup="onSyncPointerUp"
							t-on-pointercancel="onSyncPointerCancel"
							t-esc="syncIcon"
						/>
						<div t-if="state.showConfigPicker" class="breadcrumb__config-picker">
							<p class="breadcrumb__config-picker-label">Synchroniser avec :</p>
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
	`;

	static components = {
		DatePickerComponent,
		NoteBottomControlsComponent,
		NoteContentComponent,
		NoteTopControlsComponent,
		TagManagerComponent
	};

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
		});
		this.setParams();
		this.getNote();
		this.loadAllNoteIds();
		this.listenForEvents();
		onMounted(() => this.loadSyncStatus());
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

	async pushToOdoo() {
		if (this.state.isSyncing || this.state.newNote) return;

		if (!navigator.onLine) {
			await this.databaseService.setNoteSyncInfo(this.state.noteId, { syncStatus: "pending" });
			this.state.syncStatus = "pending";
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
		} catch (e: unknown) {
			this.state.syncStatus = "error";
			await this.databaseService.setNotePerServerStatus(this.state.noteId, cfg.id, "error").catch(() => {});
			const msg = e instanceof Error ? e.message : String(e);
			try { await navigator.clipboard.writeText(msg); } catch { /* clipboard unavailable */ }
			await Dialog.alert({ message: `Erreur sync :\n${msg}\n\n(texte copié dans le presse-papier)` });
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
			const msg = errors.join("\n");
			try { await navigator.clipboard.writeText(msg); } catch { /* clipboard unavailable */ }
			await Dialog.alert({ message: `Erreurs sync :\n${msg}\n\n(texte copié dans le presse-papier)` });
		} else {
			this.state.syncStatus = "synced";
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
		this.eventBus.trigger(Events.TAG_MANAGER);
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
		const onAudio = this.setAudioRecording.bind(this);
		const onVideo = this.setVideoRecording.bind(this);
		const onPhoto = this.setPhoto.bind(this);
		this.eventBus.addEventListener(Events.SET_AUDIO_RECORDING, onAudio);
		this.eventBus.addEventListener(Events.SET_VIDEO_RECORDING, onVideo);
		this.eventBus.addEventListener(Events.SET_PHOTO, onPhoto);
		onWillDestroy(() => {
			this.eventBus.removeEventListener(Events.SET_AUDIO_RECORDING, onAudio);
			this.eventBus.removeEventListener(Events.SET_VIDEO_RECORDING, onVideo);
			this.eventBus.removeEventListener(Events.SET_PHOTO, onPhoto);
		});
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
