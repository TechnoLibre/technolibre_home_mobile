import { Application, ApplicationID } from "../components/applications/types";
import { StorageGetResult, StorageUtils } from "../utils/storageUtils";
import { Constants } from "./constants";
import { AppAlreadyExistsError, AppKeyNotFoundError, NoAppMatchError, UndefinedAppListError } from "./errors";

export interface GetAppListResult {
	appList: Array<Application>;
}

export interface GetMatchesResult extends GetAppListResult {
	matches: Array<Application>;
}

export class AppService {
	private _applications?: Array<Application>;

	constructor() {
		this.setApplications();
	}

	public async getApps(): Promise<Array<Application>> {
		if (this._applications === undefined) {
			this._applications = await this.getAppsFromStorage();
		}
		return this._applications;
	}

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

	public async clear() {
		const newAppList = [];

		const saveResult = await this.saveAppListToStorage(newAppList);

		if (saveResult.value) {
			this._applications = newAppList;
		}

		return saveResult.value;
	}

	public async delete(appID: ApplicationID): Promise<boolean> {
		const matches: Array<Application> = await this.matches(appID);

		const matchingApp = matches?.[0];

		if (!matchingApp) {
			throw new NoAppMatchError();
		}

		const appList: Array<Application> = await this.getApps();

		const newAppList = appList.filter(app => app.url !== matchingApp.url || app.username !== matchingApp.username);

		const saveResult = await this.saveAppListToStorage(newAppList);

		if (saveResult.value) {
			this._applications = newAppList;
		}

		return saveResult.value;
	}

	public async edit(appID: ApplicationID, newApp: Application): Promise<boolean> {
		const newAppMatches: Array<Application> = await this.matches(this.appIDFrom(newApp));

		if (newAppMatches.length !== 0 && !this.matchesID(appID, newAppMatches[0])) {
			throw new AppAlreadyExistsError();
		}

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

		appList[editIndex] = Object.assign({}, newApp);

		const saveResult = await this.saveAppListToStorage(appList);

		if (saveResult.value) {
			this._applications = appList;
		}

		return saveResult.value;
	}

	public async matches(appID: ApplicationID): Promise<Array<Application>> {
		const appList: Array<Application> = await this.getAppsFromStorage();

		return appList.filter(app => this.matchesID(appID, app));
	}

	public async getMatch(appID: ApplicationID): Promise<Application> {
		const matches = await this.matches(appID);

		if (matches.length === 0) {
			throw new NoAppMatchError();
		}

		return matches[0];
	}

	private async getAppsFromStorage(): Promise<Array<Application>> {
		const storageGetResult: StorageGetResult<Array<Application>> = await StorageUtils.getValueByKey<Array<Application>>(
			Constants.APPLICATIONS_STORAGE_KEY
		);

		if (!storageGetResult.keyExists) {
			throw new AppKeyNotFoundError();
		}

		if (storageGetResult.value === undefined) {
			throw new UndefinedAppListError();
		}

		return storageGetResult.value;
	}

	private async saveAppListToStorage(appList: Array<Application>): Promise<{ value: boolean }> {
		return StorageUtils.setKeyValuePair(Constants.APPLICATIONS_STORAGE_KEY, appList);
	}

	public isMatchResultValid(result: Partial<GetMatchesResult>): result is GetMatchesResult {
		return result.appList !== undefined && result.matches !== undefined;
	}

	public isMatchResultEmpty(result: GetMatchesResult): boolean {
		return result.appList?.length === 0 || result.matches?.length === 0;
	}

	public appIDFrom(app: Application): ApplicationID {
		return { url: app.url, username: app.username };
	}

	private async setApplications() {
		this._applications = await this.getApps();
	}

	private matchesID(id: ApplicationID, app: Application): boolean {
		return id.url === app.url && id.username === app.username;
	}

	private equals(appOne: Application, appTwo: Application): boolean {
		return appOne.url === appTwo.url && appOne.username === appTwo.username && appOne.password === appTwo.password;
	}

	private indexOf(appList: Array<Application>, app: Application): number {
		for (let i = 0; i < appList.length; i++) {
			if (this.equals(appList[i], app)) {
				return i;
			}
		}

		return -1;
	}
}
