import { Application, ApplicationID } from "../models/application";
import { AppAlreadyExistsError, NoAppMatchError } from "../js/errors";
import { DatabaseService } from "./databaseService";
import { sameServerUrl, syncConfigIdFor } from "../models/syncConfig";


export interface GetAppListResult {
  appList: Array<Application>;
}

export interface GetMatchesResult extends GetAppListResult {
  matches: Array<Application>;
}

/**
 * What changed in the application list: the kind; the sync config id the
 * application has after the change (the one it had, for a delete; null
 * without a database); for an edit that renamed it, the id before;
 * and whether the change touches the connection a chat bus runs on (the
 * address, user, password, database or Odoo version, or an application
 * added or deleted), which autoSync, the poll interval and the ntfy fields
 * do not.
 */
export interface ApplicationsChange {
  kind: "add" | "edit" | "delete";
  configId: string | null;
  previousConfigId?: string;
  realtimeRelevant: boolean;
}

const configIdOf = (app: Application): string | null =>
  app.database ? syncConfigIdFor(app.url, app.username, app.database) : null;

/** A hook around renameSyncConfigId, given both config ids. */
type RenameHook = (oldConfigId: string, newConfigId: string) => Promise<void> | void;

export class AppService {
  private _db: DatabaseService;
  /**
   * Awaited after each add, edit and delete that reached the database. A
   * listener that fails is logged and does not fail the change.
   */
  onChanged: ((change: ApplicationsChange) => Promise<void> | void) | null = null;
  /**
   * Awaited before an edit moves the sync rows from one config id to
   * another (renameSyncConfigId), with both ids: a writer of these rows
   * (a chat upload) stops and is held until afterRename, so none writes
   * while they move. A hook that fails is logged and does not stop the
   * rename.
   */
  beforeRename: RenameHook | null = null;
  /**
   * Awaited once the rows moved, or the move failed, after beforeRename
   * ran: the held writers go on under the new id. A hook that fails is
   * logged and does not fail the edit.
   */
  afterRename: RenameHook | null = null;

  constructor(db: DatabaseService) {
    this._db = db;
  }

  /**
   * Returns all of the current apps.
   *
   * @returns The current list of apps
   */
  public async getApps(): Promise<Array<Application>> {
    return this._db.getAllApplications();
  }

  /**
   * Adds an app.
   *
   * @param app - The app to add
   *
   * @returns True if the addition succeeded, otherwise false
   *
   * @throws AppAlreadyExistsError
   * Thrown if the app already exists.
   */
  public async add(app: Application): Promise<boolean> {
    const matches: Array<Application> = await this.matches(this.appIDFrom(app));

    if (matches.length !== 0) {
      throw new AppAlreadyExistsError();
    }

    await this._db.addApplication(app);
    const configId = configIdOf(app);
    await this.notify({ kind: "add", configId, realtimeRelevant: configId !== null });
    return true;
  }

  private async notifyDelete(app: Application): Promise<void> {
    const configId = configIdOf(app);
    await this.notify({ kind: "delete", configId, realtimeRelevant: configId !== null });
  }

  private async notify(change: ApplicationsChange): Promise<void> {
    try {
      await this.onChanged?.(change);
    } catch (e) {
      console.warn("[appService] change listener failed:", e);
    }
  }

  /**
   * Clears the list of apps.
   */
  public async setOdooVersion(appID: ApplicationID, version: string): Promise<void> {
    await this._db.setApplicationOdooVersion(appID.url, appID.username, version);
  }

  public async clear(): Promise<boolean> {
    const apps = await this.getApps();
    for (const app of apps) {
      await this._db.deleteApplication(app.url, app.username);
      await this.notifyDelete(app);
    }
    return true;
  }

  /**
   * Deletes an app.
   *
   * @param appID - The id of the target app
   *
   * @returns True if the deletion succeeded, otherwise false
   *
   * @throws NoAppMatchError
   * Thrown if the list of matches is empty.
   */
  public async delete(appID: ApplicationID): Promise<boolean> {
    const matches: Array<Application> = await this.matches(appID);

    const matchingApp = matches?.[0];

    if (!matchingApp) {
      throw new NoAppMatchError();
    }

    await this._db.deleteApplication(matchingApp.url, matchingApp.username);
    // Its per-server entries no longer count in the notes' global status
    await this._db.refreshAllNoteSyncStatuses();
    await this.notifyDelete(matchingApp);
    return true;
  }

  /**
   * Edits an app.
   *
   * @param appID - The id of the target app
   *
   * @param newApp - The new version of the target app
   *
   * @returns True if the edit succeeded, otherwise false
   *
   * @throws NoAppMatchError
   * Thrown if the list of matches is empty.
   */
  public async edit(
    appID: ApplicationID,
    newApp: Application,
    options?: {
      ignorePassword?: boolean;
    }
  ): Promise<boolean> {
    const appIDMatches: Array<Application> = await this.matches(appID);
    const appToEdit = appIDMatches?.[0];

    if (!appToEdit) {
      throw new NoAppMatchError();
    }

    if (options?.ignorePassword) {
      newApp = Object.assign({}, newApp, { password: appToEdit.password });
    }

    await this._db.updateApplication(
      appID.url,
      appID.username,
      Object.assign({}, newApp)
    );
    // Sync records are keyed "url|username|database". They follow the
    // application only when it still names the same server, user and
    // database (url spelled differently): a remote id means nothing
    // elsewhere, so other edits leave them behind, non-live, and the next
    // push creates new records.
    if (appID.username === newApp.username && sameServerUrl(appID.url, newApp.url)
      && appToEdit.database === newApp.database) {
      const oldConfigId = syncConfigIdFor(appID.url, appID.username, appToEdit.database);
      const newConfigId = syncConfigIdFor(newApp.url, newApp.username, newApp.database);
      if (oldConfigId !== newConfigId) await this.renameConfigId(oldConfigId, newConfigId);
    }
    await this._db.refreshAllNoteSyncStatuses();
    const before = configIdOf(appToEdit);
    const after = configIdOf(newApp);
    const connectionChanged = !sameServerUrl(appToEdit.url, newApp.url) || appToEdit.username !== newApp.username
      || appToEdit.password !== newApp.password || appToEdit.database !== newApp.database
      || appToEdit.odooVersion !== newApp.odooVersion;
    await this.notify({
      kind: "edit",
      configId: after,
      ...(before !== null && before !== after ? { previousConfigId: before } : {}),
      realtimeRelevant: (before !== null || after !== null) && connectionChanged,
    });
    return true;
  }

  /** Moves the sync rows to the new config id, between beforeRename and afterRename. */
  private async renameConfigId(oldConfigId: string, newConfigId: string): Promise<void> {
    const hook = async (fn: RenameHook | null) => {
      try {
        await fn?.(oldConfigId, newConfigId);
      } catch (e) {
        console.warn("[appService] rename hook failed:", e);
      }
    };
    await hook(this.beforeRename);
    try {
      await this._db.renameSyncConfigId(oldConfigId, newConfigId);
    } finally {
      await hook(this.afterRename);
    }
  }

  /**
   * Returns all the apps that match the provided app id.
   *
   * @param appID - The id of the target app
   *
   * @returns The list of apps that match the provided app id
   */
  public async matches(appID: ApplicationID): Promise<Array<Application>> {
    const appList: Array<Application> = await this.getApps();

    return appList.filter((app) => this.matchesID(appID, app));
  }

  /**
   * Returns the app that matches the provided app id.
   *
   * @param appID - The id of the target app
   *
   * @returns The app that matches the provided app id
   *
   * @throws NoAppMatchError
   * Thrown if the list of matches is empty.
   */
  public async getMatch(appID: ApplicationID): Promise<Application> {
    const matches = await this.matches(appID);

    if (matches.length === 0) {
      throw new NoAppMatchError();
    }

    return matches[0];
  }

  /**
   * Returns an app's id.
   *
   * @param app - The app to use to get the id
   *
   * @returns The app's id
   */
  public appIDFrom(app: Application): ApplicationID {
    return { url: app.url, username: app.username };
  }

  private matchesID(id: ApplicationID, app: Application): boolean {
    return id.url === app.url && id.username === app.username;
  }
}
