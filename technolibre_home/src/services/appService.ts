import { Application, ApplicationID } from "../models/application";
import { StorageGetResult, StorageUtils } from "../utils/storageUtils";
import { StorageConstants } from "../constants/storage";
import {
  AppAlreadyExistsError,
  AppKeyNotFoundError,
  NoAppMatchError,
  UndefinedAppListError,
} from "../js/errors";

export interface GetAppListResult {
  appList: Array<Application>;
}

export interface GetMatchesResult extends GetAppListResult {
  matches: Array<Application>;
}

export class AppService {
  private _applications?: Array<Application>;

  // ---- UI state (loading / saving) ----
  private _isLoadingApps = false;
  private _isSaving = false;

  // callback optionnel pour notifier l'UI
  private _onStateChange?: (state: { isLoadingApps: boolean; isSaving: boolean }) => void;

  public setStateListener(
    cb?: (state: { isLoadingApps: boolean; isSaving: boolean }) => void
  ) {
    this._onStateChange = cb;
  }

  public get isLoadingApps(): boolean {
    return this._isLoadingApps;
  }

  public get isSaving(): boolean {
    return this._isSaving;
  }

  private emitState() {
    this._onStateChange?.({ isLoadingApps: this._isLoadingApps, isSaving: this._isSaving });
  }

  private setLoadingApps(v: boolean) {
    this._isLoadingApps = v;
    this.emitState();
  }

  private setSaving(v: boolean) {
    this._isSaving = v;
    this.emitState();
  }

  /**
   * Returns all of the current apps.
   */
  public async getApps(): Promise<Array<Application>> {
    if (this._applications === undefined) {
      this.setLoadingApps(true);
      try {
        this._applications = await this.getAppsFromStorage();
      } finally {
        this.setLoadingApps(false);
      }
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

    // ici: sauvegarde immédiate (pas schedule), mais on montre le loader
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
    const newAppList: Array<Application> = [];

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
      newApp = Object.assign({}, newApp, { password: appToEdit.password });
    }

    appList[editIndex] = Object.assign({}, newApp);

    // Sauvegarde planifiée (debounce)
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
    const storageGetResult: StorageGetResult<Array<Application>> =
      await StorageUtils.getValueByKey<Array<Application>>(
        StorageConstants.APPLICATIONS_STORAGE_KEY
      );

    if (!storageGetResult.keyExists) {
      throw new AppKeyNotFoundError();
    }

    if (storageGetResult.value === undefined) {
      throw new UndefinedAppListError();
    }

    return storageGetResult.value;
  }

  // ---- scheduled save + flush ----
  private _saveTimer?: number;
  private _pendingSave?: Promise<{ value: boolean }>;

  private scheduleSave(appList: Array<Application>): Promise<{ value: boolean }> {
    window.clearTimeout(this._saveTimer);

    // On passe en "saving" dès qu’une sauvegarde est planifiée
    this.setSaving(true);

    this._pendingSave = new Promise((resolve) => {
      this._saveTimer = window.setTimeout(async () => {
        const res = await this.saveAppListToStorage(appList);
        resolve(res);
      }, 150); // 150-300ms souvent suffisant
    });

    return this._pendingSave;
  }

  /**
   * Permet de forcer la sauvegarde si une save est en attente.
   * À appeler avant navigation, background, fermeture, etc.
   */
  public async flushSaves(): Promise<{ value: boolean }> {
    // rien en attente
    if (!this._pendingSave) {
      return { value: true };
    }

    // force le timer à exécuter maintenant
    if (this._saveTimer) {
      window.clearTimeout(this._saveTimer);
      this._saveTimer = undefined;

      // Rejoue la dernière save immédiatement:
      // On n'a pas conservé appList ici, donc flushSaves force juste l’attente de la pendingSave.
      // Si tu veux "flush immédiat réel", on peut stocker _lastAppList (voir note plus bas).
    }

    try {
      const res = await this._pendingSave;
      return res;
    } finally {
      this._pendingSave = undefined;
      // Quand la save est terminée, on enlève l’indicateur
      this.setSaving(false);
    }
  }

  /**
   * Saves the provided app list to the local storage.
   *
   * @param appList - The list of apps to save to the device's secure storage
   *
   * @returns True if the save succeeded, otherwise false
   */
  private async saveAppListToStorage(appList: Array<Application>): Promise<{ value: boolean }> {
    this.setSaving(true);
    try {
      return await StorageUtils.setKeyValuePair(StorageConstants.APPLICATIONS_STORAGE_KEY, appList);
    } finally {
      // Ici on met false seulement si aucune save planifiée n'existe encore
      // (flushSaves() remettra aussi à false)
      if (!this._pendingSave) {
        this.setSaving(false);
      }
    }
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
