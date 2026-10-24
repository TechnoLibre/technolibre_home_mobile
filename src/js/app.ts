import { defineCustomElements } from "@ionic/pwa-elements/loader";
import { RootComponent } from "../components/root/root_component";
import { EventBus, mount } from "@odoo/owl";
import { Capacitor } from "@capacitor/core";
import { SplashScreen } from "@capacitor/splash-screen";
import { SimpleRouter } from "./router";
import { AppService } from "../services/appService";
import { IntentService } from "../services/intentService";
import { NoteService } from "../services/note/noteService";
import { DatabaseService } from "../services/databaseService";
import { runMigrations } from "../services/migrationService";
import { APP_MIGRATIONS } from "../services/migrations";
import { RepoExtractorService } from "../services/repoExtractorService";
import { RepoEditService } from "../services/repoEditService";
import { CodeStyleService } from "../services/codeStyleService";
import { StreamDeckController } from "../services/streamDeckController";
import { StreamDeckCameraStreamer } from "../services/streamDeckCameraStreamer";
import { StreamDeckLcdTextRenderer } from "../services/streamDeckLcdTextRenderer";
import {
	streamDeckEventLog,
	reattachGaveUpText,
	permissionDeniedText,
} from "../services/streamDeckEventLog";
import { StreamDeckPlugin } from "../plugins/streamDeckPlugin";
import { restoreDeckSleepAtBoot } from "../services/deckSleepCoupling";
import { TagService } from "../services/tagService";
import { ServerService } from "../services/serverService";
import { DeploymentService } from "../services/deploymentService";
import { TranscriptionService } from "../services/transcriptionService";
import { TranslationService } from "../services/translationService";
import { MarianService } from "../services/marianService";
import { ProcessService } from "../services/processService";
import { DEFAULT_GRAPHIC_PREFS, FONT_SIZE_STEPS, applyGraphicPrefs } from "../models/graphicPrefs";
import type { FontFamily, ColorTheme } from "../models/graphicPrefs";
import { SyncService } from "../services/syncService";
import { NotificationService } from "../services/notificationService";
import { ReminderService } from "../services/reminderService";
import { BiometryUtils } from "../utils/biometryUtils";
import { Events } from "../constants/events";
import { t } from "../i18n";
import { replanFromCache } from "../services/calendarReminders";
import { loadSyncConfigs } from "../models/syncConfig";

const eventBus = new EventBus();

eventBus.addEventListener(Events.ROUTER_NAVIGATION, (event: any) => {
	window.history.pushState({}, "", event?.detail?.url);
});

eventBus.addEventListener(Events.OPEN_CAMERA, (_event: any) => {
	document.body.classList.add("transparent");
});

eventBus.addEventListener(Events.CLOSE_CAMERA, (_event: any) => {
	document.body.classList.remove("transparent");
});

function setBootStep(msg: string) {
	console.log(`[boot] ${msg}`);
	const el = document.getElementById("boot-step");
	if (el) el.textContent = msg;
}

/**
 * Pose un texte qui RESTE sous l'etape de demarrage.
 *
 * `setBootStep` se fait remplacer a chaque etape ; le resume des migrations
 * y disparaitrait en quelques centiemes de seconde. Ici il tient jusqu'a ce
 * que l'ecran de demarrage s'efface, ce qui laisse le temps de le lire sans
 * jamais attendre un geste.
 */
function setBootNote(msg: string) {
	const el = document.getElementById("boot-note");
	if (el) el.textContent = msg;
}

function hideBootScreen() {
	const el = document.getElementById("boot-screen");
	if (el) el.remove();
}

async function startApp() {
	const isNative = Capacitor.isNativePlatform();

	if (isNative) await SplashScreen.hide();

	const router = new SimpleRouter();

	setBootStep(t("boot.checking_biometric"));
	const authenticated = isNative
		? await BiometryUtils.authenticateForDatabase()
		: true;
	if (!authenticated) {
		setBootStep(t("boot.biometric_failed"));
		return;
	}

	setBootStep(t("boot.reading_encryption_key"));
	const db = new DatabaseService();

	if (isNative) {

	await db.initialize(setBootStep);

	setBootStep(t("boot.checking_migrations"));
	await runMigrations(db, APP_MIGRATIONS, setBootNote);

	setBootStep(t("boot.loading_graphic_prefs"));
	{
		const fontFamily = await db.getUserGraphicPref("font_family") as FontFamily | null;
		const fontSizeScale = await db.getUserGraphicPref("font_size_scale");
		const colorTheme = await db.getUserGraphicPref("color_theme") as ColorTheme | null;
		const reduceMotionRaw = await db.getUserGraphicPref("reduce_motion");
		applyGraphicPrefs({
			fontFamily: fontFamily ?? DEFAULT_GRAPHIC_PREFS.fontFamily,
			fontSizeScale: fontSizeScale ? parseFloat(fontSizeScale) : DEFAULT_GRAPHIC_PREFS.fontSizeScale,
			colorTheme: colorTheme ?? DEFAULT_GRAPHIC_PREFS.colorTheme,
			reduceMotion: reduceMotionRaw === "true",
		});
	}

	} // end if (isNative)

	setBootStep(t("boot.initializing_services"));
	const appService = new AppService(db);
	const tagService = new TagService(db);
	const noteService = new NoteService(eventBus, db);
	const intentService = new IntentService(eventBus);
	const syncService = new SyncService(db);
	syncService.onNotePulled = (noteId) => eventBus.trigger(Events.NOTE_PULLED, { noteId });
	if (isNative) {
		await syncService.outbox.recoverInterrupted().catch((e) =>
			console.warn("[boot] outbox recovery failed:", e));
		// An update or a forced stop cancels the reminders' alarms: schedule them again from the cache
		void loadSyncConfigs(appService)
			.then((configs) => replanFromCache(syncService.calendar, configs.map((c) => c.id)))
			.catch((e) => console.warn("[boot] reminders not replanned:", e));
	}
	const reminderService = new ReminderService(db);
	const notificationService = new NotificationService(syncService, appService, eventBus);
	const serverService = new ServerService(db);
	const deploymentService = new DeploymentService(serverService);
	const processService = new ProcessService(db);
	if (isNative) await processService.initialize();
	const transcriptionService = new TranscriptionService(db, processService, eventBus);
	const translationService = new TranslationService(db);
	const marianService = new MarianService();

	// Service-level transcription persistence — survives the audio
	// component (or its parent note) being unmounted. The audio
	// component used to fire SET_ENTRY_TRANSCRIPTION itself after the
	// transcribe() await, but if the user navigated to /options/processes
	// (or another note) before the model finished, that listener chain
	// was already torn down and the text was silently dropped. Now the
	// service fires it; this listener writes the text into the matching
	// entry's params and persists. NoteComponent's own listener still
	// updates in-memory state when the user is on the note.
	eventBus.addEventListener(Events.SET_ENTRY_TRANSCRIPTION, (e: any) => {
		const detail = e?.detail;
		if (!detail?.entryId || !detail?.text || !detail?.noteId) return;
		(async () => {
			try {
				const note = await noteService.getMatch(detail.noteId);
				const entry = note.entries.find((en: any) => en.id === detail.entryId);
				if (!entry || entry.type !== "audio") return;
				const params = entry.params as { transcription?: string };
				if (params.transcription === detail.text) return;
				params.transcription = detail.text;
				await noteService.crud.edit(note.id, note);
			} catch (err) {
				console.warn("[boot] persist transcription failed:", err);
			}
		})();
	});
	const repoExtractorService = new RepoExtractorService();
	const repoEditService = new RepoEditService(repoExtractorService, {
		run: (sql: string, params?: unknown[]) => db.rawRun(sql, (params ?? []) as any[]),
		all: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
			db.rawQuery(sql, params as any[] | undefined) as Promise<T[]>,
	});
	const codeStyleService = new CodeStyleService(db);
	await codeStyleService.loadAndApply();
	const streamDeckController = new StreamDeckController(eventBus, noteService);
	streamDeckController.start().catch((e) =>
		console.warn("[boot] StreamDeckController.start failed:", e),
	);
	// After the controller exists: it follows the restored deck-lit
	// option through STREAMDECK_KEEP_AWAKE.
	restoreDeckSleepAtBoot(eventBus).catch((e) =>
		console.warn("[boot] restoreDeckSleepAtBoot failed:", e),
	);
	const streamDeckCameraStreamer = new StreamDeckCameraStreamer(streamDeckController);
	const streamDeckLcdTextRenderer = new StreamDeckLcdTextRenderer();
	streamDeckLcdTextRenderer.start().catch((e) =>
		console.warn("[boot] StreamDeckLcdTextRenderer.start failed:", e),
	);

	// Boot-time subscriptions to feed the singleton event log so the
	// diagnostic Options panel keeps history across navigation.
	StreamDeckPlugin.addListener("deckConnected", (ev) =>
		streamDeckEventLog.add(`deckConnected: ${ev.deckId}`),
	).catch(() => {});
	StreamDeckPlugin.addListener("deckDisconnected", (ev) =>
		streamDeckEventLog.add(`deckDisconnected: ${ev.deckId} (${ev.reason ?? "no reason"})`),
	).catch(() => {});
	StreamDeckPlugin.addListener("permissionDenied", (ev) =>
		streamDeckEventLog.add(permissionDeniedText(ev)),
	).catch(() => {});
	StreamDeckPlugin.addListener("keyChanged", (ev) => {
		if (!ev.pressed) return;
		streamDeckEventLog.add(`keyChanged: deck=${ev.deckId} key=${ev.key} pressed=true`);
	}).catch(() => {});
	StreamDeckPlugin.addListener("dialRotated", (ev) =>
		streamDeckEventLog.add(`dialRotated: dial=${ev.dial} delta=${ev.delta}`),
	).catch(() => {});
	StreamDeckPlugin.addListener("dialPressed", (ev) => {
		if (!ev.pressed) return;
		streamDeckEventLog.add(`dialPressed: dial=${ev.dial}`);
	}).catch(() => {});
	StreamDeckPlugin.addListener("lcdTouched", (ev) =>
		streamDeckEventLog.add(`lcdTouched: type=${ev.type} x=${ev.x} y=${ev.y}`),
	).catch(() => {});
	StreamDeckPlugin.addListener("neoTouched", (ev) => {
		if (!ev.pressed) return;
		streamDeckEventLog.add(`neoTouched: index=${ev.index}`);
	}).catch(() => {});
	StreamDeckPlugin.addListener("writeFailed", (ev) =>
		streamDeckEventLog.add(`writeFailed: deck=${ev.deckId} key=${ev.key} (${ev.reason})`),
	).catch(() => {});
	StreamDeckPlugin.addListener("reattachGaveUp", (ev) =>
		streamDeckEventLog.add(reattachGaveUpText(ev)),
	).catch(() => {});
	StreamDeckPlugin.addListener("rawInputReport", (ev) =>
		streamDeckEventLog.add(`raw[${ev.len}]: ${ev.bytes}`),
	).catch(() => {});
	notificationService.start();

	// Re-schedule any reminders whose notification batch is expiring
	reminderService.rebatchExpiring().catch((e) =>
		console.warn("[boot] rebatchExpiring failed:", e)
	);

	const env = { eventBus, router, appService, tagService, noteService, intentService, databaseService: db, syncService, notificationService, serverService, deploymentService, transcriptionService, translationService, marianService, processService, repoExtractorService, repoEditService, codeStyleService, streamDeckController, streamDeckCameraStreamer, streamDeckLcdTextRenderer };

	setBootStep(t("boot.mounting_interface"));
	await mount(RootComponent, document.body, { env });
	defineCustomElements(window);
	hideBootScreen();
}

startApp().catch((error) => {
	console.error("Failed to start app:", error);
	setBootStep(t("boot.error", { message: error?.message ?? error }));
});