import {Application, ApplicationID} from "../models/application";
import {StorageGetResult, StorageUtils} from "../utils/storageUtils";
import {StorageConstants} from "../constants/storage";
import {AppAlreadyExistsError, AppKeyNotFoundError, NoAppMatchError, UndefinedAppListError} from "../js/errors";

export interface GetAppListResult {
  appList: Array<Application>;
}

export interface GetMatchesResult extends GetAppListResult {
  matches: Array<Application>;
}

export class AppService {
  private _applications?: Array<Application>;

  /**
   * Returns all of the current apps.
   *
   * @returns The current list of apps
   *
   * @throws AppKeyNotFoundError
   * Thrown if the applications key is not found in the secure storage.
   *
   * @throws UndefinedAppListError
   * Thrown if the list of apps is undefined.
   */
  public async getApps(): Promise<Array<Application>> {
    if (this._applications === undefined) {
      this._applications = await this.getAppsFromStorage();
    }
    return this._applications;
  }

  /**
   * Adds an app.
   *
   * @param app - The app to add
   *
   * @returns True if the addition succeeded, otherwise false
   *
   * @throw AppAlreadyExistsError
   * Thrown if the app already exists.
   *
   * @throws AppKeyNotFoundError
   * Thrown if the applications key is not found in the secure storage.
   *
   * @throws UndefinedAppListError
   * Thrown if the list of apps is undefined.
   */
  public async add(app: Application): Promise<boolean> {
    const matches: Array<Application> = await this.matches(this.appIDFrom(app));

    if (matches.length !== 0) {
      throw new AppAlreadyExistsError();
    }

    const appList = await this.getApps();
    appList.push(app);

    const saveResult = await this.saveAppListToStorage(appList);

    if (saveResult.value) {
      this._applications = appList;
    }

    return saveResult.value;
  }

  /**
   * Clears the list of apps.
   */
  public async clear() {
    const newAppList = [];

    const saveResult = await this.saveAppListToStorage(newAppList);

    if (saveResult.value) {
      this._applications = newAppList;
    }

    return saveResult.value;
  }

  /**
   * Deletes an app.
   *
   * @param appId - The id of the target app
   *
   * @returns True if the deletion succeeded, otherwise false
   *
   * @throws NoAppMatchError
   * Thrown if the list of matches is empty.
   *
   * @throws AppKeyNotFoundError
   * Thrown if the applications key is not found in the secure storage.
   *
   * @throws UndefinedAppListError
   * Thrown if the list of apps is undefined.
   */
  public async delete(appID: ApplicationID): Promise<boolean> {
    const matches: Array<Application> = await this.matches(appID);

    const matchingApp = matches?.[0];

    if (!matchingApp) {
      throw new NoAppMatchError();
    }

    const appList: Array<Application> = await this.getApps();

    const newAppList = appList.filter(
      (app) => app.url !== matchingApp.url || app.username !== matchingApp.username
    );

    const saveResult = await this.saveAppListToStorage(newAppList);

    if (saveResult.value) {
      this._applications = newAppList;
    }

    return saveResult.value;
  }

  /**
   * Edits an app.
   *
   * @param appId - The id of the target app
   *
   * @param newApp - The new version of the target app
   *
   * @returns True if the edit succeeded, otherwise false
   *
   * @throws AppAlreadyExistsError
   * Thrown if the app already exists.
   *
   * @throws NoAppMatchError
   * Thrown if the list of matches is empty.
   *
   * @throws AppKeyNotFoundError
   * Thrown if the apps key is not found in the secure storage.
   *
   * @throws UndefinedAppListError
   * Thrown if the list of apps is undefined.
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

    const appList = await this.getApps();
    const editIndex = this.indexOf(appList, appToEdit);

    if (editIndex === -1) {
      throw new NoAppMatchError();
    }

    if (options?.ignorePassword) {
      // on garde exactement le password existant en storage
      newApp = Object.assign({}, newApp, {password: appToEdit.password});
    }

    appList[editIndex] = Object.assign({}, newApp);

    // const saveResult = await this.saveAppListToStorage(appList);
    const saveResult = await this.scheduleSave(appList);

    if (saveResult.value) {
      this._applications = appList;
    }

    return saveResult.value;
  }

  /**
   * Returns all the apps that match the provided app id.
   *
   * @param appId - The id of the target app
   *
   * @returns The list of apps that match the provided app id
   *
   * @throws AppKeyNotFoundError
   * Thrown if the applications key is not found in the secure storage.
   *
   * @throws UndefinedAppListError
   * Thrown if the list of apps is undefined.
   */
  public async matches(appID: ApplicationID): Promise<Array<Application>> {
    const appList: Array<Application> = await this.getApps();

    return appList.filter((app) => this.matchesID(appID, app));
  }

  /**
   * Returns the app that matches the provided app id.
   *
   * @param appId - The id of the target app
   *
   * @returns The app that matches the provided app id
   *
   * @throws NoAppMatchError
   * Thrown if the list of matches is empty.
   *
   * @throws AppKeyNotFoundError
   * Thrown if the applications key is not found in the secure storage.
   *
   * @throws UndefinedAppListError
   * Thrown if the list of apps is undefined.
   */
  public async getMatch(appID: ApplicationID): Promise<Application> {
    const matches = await this.matches(appID);

    if (matches.length === 0) {
      throw new NoAppMatchError();
    }

    return matches[0];
  }

  /**
   * Returns all the apps from the local storage.
   *
   * @returns The list of apps from the device's secure storage
   *
   * @throws AppKeyNotFoundError
   * Thrown if the applications key is not found in the secure storage.
   *
   * @throws UndefinedAppListError
   * Thrown if the list of apps is undefined.
   */
  private async getAppsFromStorage(): Promise<Array<Application>> {
    const storageGetResult: StorageGetResult<Array<Application>> = await StorageUtils.getValueByKey<
      Array<Application>
    >(StorageConstants.APPLICATIONS_STORAGE_KEY);

    if (!storageGetResult.keyExists) {
      throw new AppKeyNotFoundError();
    }

    if (storageGetResult.value === undefined) {
      throw new UndefinedAppListError();
    }

    return storageGetResult.value;
  }

  private _saveTimer?: number;
  private _pendingSave?: Promise<{ value: boolean }>;

  private scheduleSave(appList: Array<Application>): Promise<{ value: boolean }> {
    window.clearTimeout(this._saveTimer);

    return new Promise((resolve) => {
      this._saveTimer = window.setTimeout(async () => {
        const res = await this.saveAppListToStorage(appList);
        resolve(res);
      }, 150); // 150-300ms souvent suffisant
    });
  }

  /**
   * Saves the provided app list to the local storage.
   *
   * @param appList - The list of apps to save to the device's secure storage
   *
   * @returns True if the save succeeded, otherwise false
   */
  private async saveAppListToStorage(appList: Array<Application>): Promise<{ value: boolean }> {
    return StorageUtils.setKeyValuePair(StorageConstants.APPLICATIONS_STORAGE_KEY, appList);
  }

  /**
   * Returns an app's id.
   *
   * @param app - The app to use to get the id
   *
   * @returns The app's id
   */
  public appIDFrom(app: Application): ApplicationID {
    return {url: app.url, username: app.username};
  }

  private matchesID(id: ApplicationID, app: Application): boolean {
    return id.url === app.url && id.username === app.username;
  }

  /**
   * Determines the equality of two apps.
   *
   * @param appOne - The first app to compare
   *
   * @param appTwo - The second app to compare
   *
   * @returns True if the two apps are equal, otherwise false
   */
  private equals(appOne: Application, appTwo: Application): boolean {
    return appOne.url === appTwo.url && appOne.username === appTwo.username && appOne.password === appTwo.password;
  }

  /**
   * Returns the index of the matching app in the app list.
   * If no match is found, returns -1.
   *
   * @param appList - The list of apps to search
   *
   * @param app - The app to look for
   *
   * @returns The index of the app in the list
   */
  private indexOf(appList: Array<Application>, app: Application): number {
    for (let i = 0; i < appList.length; i++) {
      if (this.equals(appList[i], app)) {
        return i;
      }
    }

    return -1;
  }
}
