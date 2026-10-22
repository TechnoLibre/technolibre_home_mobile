import type { Application } from "./application";
import type { AppService } from "../services/appService";

/**
 * Id of one sync target, "url|username|database". Every sync record — per-
 * server status, note link, pull cursor, remembered selection — is keyed by
 * it: a remote id is only meaningful in the database that issued it, so an
 * application switched to another database is another target.
 */
export function syncConfigIdFor(url: string, username: string, database: string): string {
  return `${url}|${username}|${database}`;
}

/**
 * Whether two application urls name the same server: equal once scheme,
 * letter case and trailing slashes are ignored.
 */
export function sameServerUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return norm(a) === norm(b);
}

export interface SyncConfig {
  /** Stable ID, see syncConfigIdFor */
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
    id: syncConfigIdFor(app.url, app.username, app.database),
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
