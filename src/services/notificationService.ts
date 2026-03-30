import { App } from "@capacitor/app";
import { EventBus } from "@odoo/owl";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";

import { Events } from "../constants/events";
import { StorageConstants } from "../constants/storage";
import { SyncService, SyncCredentials } from "./syncService";
import { AppService } from "./appService";
import { NtfyService } from "./ntfyService";
import { SyncConfig } from "../components/options/sync/options_sync_component";

/**
 * Polls Odoo periodically for changes while the app is in the foreground.
 * Emits SYNC_CHANGES_DETECTED via the event bus when modified task IDs
 * are found. Pauses automatically when the app goes to background.
 *
 * Also:
 * - Syncs pending notes when network connectivity is restored.
 * - Subscribes to a NTFY topic (SSE) for real-time push from Odoo.
 *
 * Background polling requires @capacitor/background-runner (not installed).
 * Install and wire it here in v2 if needed.
 * For background NTFY notifications, the user should install the NTFY
 * Android app and subscribe to the same topic.
 */
export class NotificationService {
  private syncService: SyncService;
  private appService: AppService;
  private eventBus: EventBus;
  private ntfyService: NtfyService;
  private timerId: ReturnType<typeof setInterval> | null = null;
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

    // Network restore → flush pending queue
    window.addEventListener("online", () => this.onNetworkRestore());

    // Start immediately (app is active at boot)
    this.startPolling();
    this.startNtfy();
  }

  /**
   * Reads current SyncConfig and starts the interval if autoSync is enabled.
   */
  private async startPolling(): Promise<void> {
    this.stopPolling();
    const config = await this.loadConfig();
    if (!config || !config.autoSync || config.pollIntervalMinutes <= 0) return;
    if (!config.appUrl || !config.database) return;

    const intervalMs = config.pollIntervalMinutes * 60 * 1000;
    this.timerId = setInterval(() => this.poll(), intervalMs);
  }

  private stopPolling(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /**
   * Opens the NTFY SSE connection based on current config.
   */
  private async startNtfy(): Promise<void> {
    this.ntfyService.disconnect();
    const config = await this.loadConfig();
    if (!config?.ntfyUrl || !config.ntfyTopic) return;

    this.ntfyService.connect(config.ntfyUrl, config.ntfyTopic, (_title) => {
      this.onNtfyMessage(config);
    });
  }

  /**
   * Called when a NTFY message is received. Triggers a poll immediately.
   */
  private async onNtfyMessage(config: SyncConfig): Promise<void> {
    if (!config.appUrl || !config.database) return;
    const creds = await this.buildCreds(config);
    if (!creds) return;

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
   * Called when network connectivity is restored.
   * Syncs all notes marked as 'pending' for the configured Odoo instance.
   */
  private async onNetworkRestore(): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.appUrl || !config.database) return;
    const creds = await this.buildCreds(config);
    if (!creds) return;

    try {
      await this.syncService.syncAll(creds);
      this.eventBus.trigger(Events.RELOAD_NOTES);
    } catch (e) {
      console.warn("[NotificationService] reconnect sync failed:", e);
    }

    // Re-open NTFY connection after network restored
    this.startNtfy();
  }

  /**
   * Performs a lightweight poll and emits an event if changes are found.
   */
  private async poll(): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.appUrl || !config.database) return;
    const creds = await this.buildCreds(config);
    if (!creds) return;

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

  private async buildCreds(config: SyncConfig): Promise<SyncCredentials | null> {
    const apps = await this.appService.getApps();
    const app = apps.find(
      (a) => a.url === config.appUrl && a.username === config.appUsername
    );
    if (!app) return null;
    return {
      odooUrl: config.appUrl,
      username: app.username,
      password: app.password,
      database: config.database,
    };
  }

  private async loadConfig(): Promise<SyncConfig | null> {
    try {
      const result = await SecureStoragePlugin.get({
        key: StorageConstants.SYNC_CONFIG_KEY,
      });
      return JSON.parse(result.value) as SyncConfig;
    } catch {
      return null;
    }
  }
}
