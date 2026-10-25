import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { EventBus } from "@odoo/owl";

import { Events } from "../constants/events";
import { SyncService, SyncCredentials } from "./syncService";
import { syncConfigIdFor } from "../models/syncConfig";
import { AppService } from "./appService";
import { NtfyService } from "./ntfyService";
import { Application } from "../models/application";
import { NetworkService, networkService } from "./networkService";
import { RETRY_MAX_MS } from "./outboxService";
import { publishPending } from "./pendingSyncNotice";

/** Margin past a row's retry time before the timer fires, so it is due. */
const RETRY_TIMER_SLACK_MS = 1000;

/**
 * Polls Odoo periodically for changes while the app is in the foreground.
 * Reads sync configuration directly from the Application list — each app
 * with autoSync=true and a configured database gets its own polling timer.
 *
 * Emits SYNC_CHANGES_DETECTED via the event bus when modified task IDs
 * are found. Pauses automatically when the app goes to background.
 *
 * Also:
 * - Syncs every server when network connectivity is restored (retry
 *   delays ignored), and the servers with due work at startup and each
 *   time the app returns to the foreground (retry delays respected).
 * - Subscribes to a NTFY topic (SSE) for real-time push from Odoo
 *   (uses the first app with ntfyUrl/ntfyTopic configured).
 * - Publishes, going to the background, what still waits for the sync to
 *   the native NoteSyncJob, which notifies it while the app is closed
 *   (see pendingSyncNotice); coming back clears that notice.
 */
export class NotificationService {
  private syncService: SyncService;
  private appService: AppService;
  private eventBus: EventBus;
  private ntfyService: NtfyService;
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastPoll: Date = new Date(0);
  private network: NetworkService;
  /** Timer of the next automatic retry of a failed outbox row, if armed. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by each scheduleRetry and each clear: only the latest call arms. */
  private retryGeneration = 0;
  /** Whether the app is in the foreground; no retry timer is armed otherwise. */
  private active = true;

  constructor(
    syncService: SyncService,
    appService: AppService,
    eventBus: EventBus,
    network: NetworkService = networkService
  ) {
    this.syncService = syncService;
    this.appService = appService;
    this.eventBus = eventBus;
    this.ntfyService = new NtfyService();
    this.network = network;
  }

  /**
   * Registers app lifecycle listeners and starts polling if configured.
   * Listens to network reconnection to flush the offline queue, and
   * flushes what is due now. Call once at app startup.
   */
  start(): void {
    if (Capacitor.isNativePlatform()) {
      App.addListener("appStateChange", ({ isActive }) => {
        this.active = isActive;
        // App closed, the native NoteSyncJob tells what still waits; open, it stays quiet
        void publishPending(this.syncService.db, isActive);
        if (isActive) {
          this.startPolling();
          this.startNtfy();
          void this.flushDue();
        } else {
          this.stopPolling();
          this.ntfyService.disconnect();
          this.clearRetryTimer();
        }
      });
      void publishPending(this.syncService.db, true);
    }

    void this.network.onReconnect(() => this.onNetworkRestore());
    // Onto Wi-Fi, files held back for it can go: only the servers with due work
    void this.network.onWifi(() => { void this.flushDue(); });
    // A row that fails on a tap, or anywhere else, moves the next retry
    this.syncService.onRetryScheduled = () => { void this.scheduleRetry(); };
    // A sync ending in the background (one begun in front) changes what the closed app's notice says
    this.syncService.onAfterSync = () => {
      if (!this.active) void publishPending(this.syncService.db, false);
    };

    // Start immediately (app is active at boot)
    this.startPolling();
    this.startNtfy();
    void this.flushDue();
  }

  /**
   * Syncs, when online, each server that has due work (see
   * SyncService.hasDueWork), then arms the timer of the next automatic
   * retry. Covers the queue left by a session that ended offline, which
   * no reconnect event would ever flush. A pull that changes a note queues
   * its other servers, those synced earlier in the pass included: a server
   * is synced again when it has pending notes it did not have right after
   * its own sync, at most one pass more than there are servers; one still
   * pending for its own reason (a file held for Wi-Fi) is not.
   */
  private flushDue(): Promise<void> {
    // One flush at a time: a call during one runs once more after it, not beside it
    if (this._flushing) {
      this._flushAgain = true;
      return this._flushing;
    }
    this._flushing = (async () => {
      do {
        this._flushAgain = false;
        await this.flushDueNow();
      } while (this._flushAgain);
    })().finally(() => { this._flushing = null; });
    return this._flushing;
  }

  /** The flush in progress (see flushDue), and whether a call came during it. */
  private _flushing: Promise<void> | null = null;
  private _flushAgain = false;

  private async flushDueNow(): Promise<void> {
    try {
      if (!(await this.network.isOnline())) return;
      const apps = (await this.appService.getApps()).filter((a) => a.database);
      let synced = false;
      const pendingAfter = new Map<string, Set<string>>();
      for (let pass = 0; pass <= apps.length; pass++) {
        let any = false;
        for (const app of apps) {
          const configId = syncConfigIdFor(app.url, app.username, app.database);
          const due = pass === 0
            ? await this.syncService.hasDueWork(configId)
            : (await this.syncService.pendingNoteIds(configId)).some((id) => !pendingAfter.get(configId)?.has(id));
          if (!due) {
            // Not due at first: what it already waits for is no news for the next passes
            if (pass === 0) pendingAfter.set(configId, new Set(await this.syncService.pendingNoteIds(configId)));
            continue;
          }
          await this.syncService.syncAll(this.appToCreds(app), undefined, { force: false });
          pendingAfter.set(configId, new Set(await this.syncService.pendingNoteIds(configId)));
          synced = any = true;
        }
        if (!any) break;
      }
      if (synced) this.eventBus.trigger(Events.RELOAD_NOTES);
      // Chat rows have their own drain; SyncService.hasDueWork leaves them out
      await this.syncService.chat.flushAll()
        .catch((e) => console.warn("[NotificationService] chat flush failed:", e));
      await this.scheduleRetry();
    } catch (e) {
      console.warn("[NotificationService] flush of due work failed:", e);
    }
  }

  /**
   * Arms one timer for the earliest retry time of a failed outbox row on
   * any server, which runs flushDue. Without it a failed creation would
   * wait, app open and network up, for the next resume or reconnect.
   * Re-armed each time a row fails (SyncService.onRetryScheduled); the
   * delay is capped at RETRY_MAX_MS, beyond which setTimeout would
   * overflow. Never armed in the background, and cleared on going there.
   */
  private async scheduleRetry(): Promise<void> {
    const generation = ++this.retryGeneration;
    const apps = (await this.appService.getApps()).filter((a) => a.database);
    let earliest: string | null = null;
    for (const app of apps) {
      const at = await this.syncService.nextRetryAt(syncConfigIdFor(app.url, app.username, app.database));
      if (at && (!earliest || at < earliest)) earliest = at;
    }
    // A later call, or the app going to the background, won meanwhile
    if (generation !== this.retryGeneration || !this.active) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!earliest) return;
    const delay = Math.min(
      Math.max(0, new Date(earliest).getTime() - Date.now()),
      RETRY_MAX_MS
    ) + RETRY_TIMER_SLACK_MS;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flushDue();
    }, delay);
  }

  private clearRetryTimer(): void {
    this.retryGeneration++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * Reads all apps and starts one timer per app with autoSync enabled.
   */
  private async startPolling(): Promise<void> {
    this.stopPolling();
    const apps = await this.appService.getApps();
    for (const app of apps) {
      if (!app.autoSync || !app.database || app.pollIntervalMinutes <= 0) continue;
      const intervalMs = app.pollIntervalMinutes * 60 * 1000;
      this.timers.push(setInterval(() => this.pollApp(app), intervalMs));
    }
  }

  private stopPolling(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /**
   * Opens the NTFY SSE connection for the first app with NTFY configured.
   */
  private async startNtfy(): Promise<void> {
    this.ntfyService.disconnect();
    const apps = await this.appService.getApps();
    const ntfyApp = apps.find((a) => a.ntfyUrl && a.ntfyTopic);
    if (!ntfyApp) return;

    this.ntfyService.connect(ntfyApp.ntfyUrl, ntfyApp.ntfyTopic, (_title) => {
      this.onNtfyMessage(ntfyApp);
    }, ntfyApp.ntfyToken || undefined);
  }

  private async onNtfyMessage(app: Application): Promise<void> {
    if (!app.database) return;
    const creds = this.appToCreds(app);
    try {
      const since = this.lastPoll;
      this.lastPoll = new Date();
      const changedIds = await this.syncService.pollForChanges(creds, since);
      if (changedIds.length > 0) {
        this.eventBus.trigger(Events.SYNC_CHANGES_DETECTED, {
          count: changedIds.length,
          odooIds: changedIds,
          creds,
        });
      }
    } catch (e) {
      console.warn("[NotificationService] NTFY-triggered poll failed:", e);
    }
  }

  /**
   * Syncs every application, retry delays ignored since the failures
   * likely came from the missing network, then once more each one a later
   * pull queued notes for: a pull that changes a note queues its other
   * servers, and those may already have been synced in the first pass.
   * The second pass respects the delays, so a creation that failed again
   * in the first pass is not retried at once. The chat goes first and
   * beside the notes: its buses reconnect at once and its outbox drains,
   * retry delays ignored, while the notes sync.
   */
  private async onNetworkRestore(): Promise<void> {
    this.syncService.chat.reconnectNow();
    const chatFlush = this.syncService.chat.flushAll({ force: true })
      .catch((e) => console.warn("[NotificationService] chat flush:", e));
    const apps = (await this.appService.getApps()).filter((a) => a.database);
    const syncApp = async (app: Application, force = true) => {
      try {
        await this.syncService.syncAll(this.appToCreds(app), undefined, { force });
      } catch (e) {
        console.warn("[NotificationService] reconnect sync failed:", e);
      }
    };
    for (const app of apps) await syncApp(app);
    for (const app of apps) {
      const configId = syncConfigIdFor(app.url, app.username, app.database);
      if ((await this.syncService.pendingNoteIds(configId)).length > 0) await syncApp(app, false);
    }
    this.eventBus.trigger(Events.RELOAD_NOTES);
    await chatFlush;
    this.startNtfy();
    await this.scheduleRetry().catch((e) => console.warn("[NotificationService] retry timer:", e));
  }

  private async pollApp(app: Application): Promise<void> {
    if (!app.database) return;
    const creds = this.appToCreds(app);
    try {
      const since = this.lastPoll;
      this.lastPoll = new Date();
      const changedIds = await this.syncService.pollForChanges(creds, since);
      if (changedIds.length > 0) {
        this.eventBus.trigger(Events.SYNC_CHANGES_DETECTED, {
          count: changedIds.length,
          odooIds: changedIds,
          creds,
        });
      }
    } catch (e) {
      console.warn("[NotificationService] poll failed:", e);
    }
  }

  /**
   * Reloads config and restarts polling and NTFY with updated settings.
   * Call after the user saves new sync settings.
   */
  async reload(): Promise<void> {
    await this.startPolling();
    await this.startNtfy();
  }

  private appToCreds(app: Application): SyncCredentials {
    return {
      odooUrl: app.url,
      username: app.username,
      password: app.password,
      database: app.database,
    };
  }
}
