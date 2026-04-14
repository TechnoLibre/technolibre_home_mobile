import { App } from "@capacitor/app";
import { EventBus } from "@odoo/owl";

import { Events } from "../constants/events";
import { SyncService, SyncCredentials } from "./syncService";
import { AppService } from "./appService";
import { NtfyService } from "./ntfyService";
import { Application } from "../models/application";

/**
 * Polls Odoo periodically for changes while the app is in the foreground.
 * Reads sync configuration directly from the Application list — each app
 * with autoSync=true and a configured database gets its own polling timer.
 *
 * Emits SYNC_CHANGES_DETECTED via the event bus when modified task IDs
 * are found. Pauses automatically when the app goes to background.
 *
 * Also:
 * - Syncs pending notes when network connectivity is restored.
 * - Subscribes to a NTFY topic (SSE) for real-time push from Odoo
 *   (uses the first app with ntfyUrl/ntfyTopic configured).
 */
export class NotificationService {
  private syncService: SyncService;
  private appService: AppService;
  private eventBus: EventBus;
  private ntfyService: NtfyService;
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastPoll: Date = new Date(0);

  constructor(syncService: SyncService, appService: AppService, eventBus: EventBus) {
    this.syncService = syncService;
    this.appService = appService;
    this.eventBus = eventBus;
    this.ntfyService = new NtfyService();
  }

  /**
   * Registers app lifecycle listeners and starts polling if configured.
   * Listens to network reconnection to flush the offline queue.
   * Call once at app startup.
   */
  start(): void {
    App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) {
        this.startPolling();
        this.startNtfy();
      } else {
        this.stopPolling();
        this.ntfyService.disconnect();
      }
    });

    window.addEventListener("online", () => this.onNetworkRestore());

    // Start immediately (app is active at boot)
    this.startPolling();
    this.startNtfy();
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

  private async onNetworkRestore(): Promise<void> {
    const apps = await this.appService.getApps();
    for (const app of apps) {
      if (!app.database) continue;
      try {
        await this.syncService.syncAll(this.appToCreds(app));
      } catch (e) {
        console.warn("[NotificationService] reconnect sync failed:", e);
      }
    }
    this.eventBus.trigger(Events.RELOAD_NOTES);
    this.startNtfy();
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
