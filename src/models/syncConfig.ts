import type { Application } from "./application";
import type { AppService } from "../services/appService";

export interface SyncConfig {
  /** Stable ID derived as "url|username" */
  id: string;
  /** Display name — defaults to the app URL */
  name: string;
  appUrl: string;
  appUsername: string;
  database: string;
  autoSync: boolean;
  pollIntervalMinutes: number;
  ntfyUrl: string;
  ntfyTopic: string;
}

/** Convert an Application to a SyncConfig. */
export function appToSyncConfig(app: Application): SyncConfig {
  return {
    id: app.url + "|" + app.username,
    name: app.url,
    appUrl: app.url,
    appUsername: app.username,
    database: app.database,
    autoSync: app.autoSync,
    pollIntervalMinutes: app.pollIntervalMinutes,
    ntfyUrl: app.ntfyUrl,
    ntfyTopic: app.ntfyTopic,
  };
}

/**
 * Returns sync configs derived from the application list.
 * Only applications with a database configured are included.
 */
export async function loadSyncConfigs(appService: AppService): Promise<SyncConfig[]> {
  const apps = await appService.getApps();
  return apps.filter((a) => a.database).map(appToSyncConfig);
}
