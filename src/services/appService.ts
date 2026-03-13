import { Application, ApplicationID } from "../models/application";
import { AppAlreadyExistsError, NoAppMatchError } from "../js/errors";
import { DatabaseService } from "./databaseService";

export interface GetAppListResult {
  appList: Array<Application>;
}

export interface GetMatchesResult extends GetAppListResult {
  matches: Array<Application>;
}

export class AppService {
  private _db: DatabaseService;

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
    return true;
  }

  /**
   * Clears the list of apps.
   */
  public async clear(): Promise<boolean> {
    const apps = await this.getApps();
    for (const app of apps) {
      await this._db.deleteApplication(app.url, app.username);
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
    return true;
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
