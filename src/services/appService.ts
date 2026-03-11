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
	// In-memory cache
	private _applications?: Array<Application>;
	private _db: DatabaseService;

	constructor() {
		this._db = DatabaseService.getInstance();
	}

	/**
	 * Returns all applications. Uses the cache if available, otherwise reads from SQLite.
	 */
	public async getApps(): Promise<Array<Application>> {
		if (this._applications === undefined) {
			this._applications = await this._db.getAllApplications();
		}
		return this._applications;
	}

	/**
	 * Adds an application. Throws if it already exists.
	 */
	public async add(app: Application): Promise<boolean> {
		const matches = await this.matches(this.appIDFrom(app));

		if (matches.length !== 0) {
			throw new AppAlreadyExistsError();
		}

		try {
			await this._db.addApplication(app);
			this._applications = undefined; // Invalidate cache
			return true;
		} catch (error) {
			console.error("Failed to add application:", error);
			return false;
		}
	}

	/**
	 * Clears all applications.
	 */
	public async clear(): Promise<boolean> {
		try {
			await this._db.clearApplications();
			this._applications = undefined;
			return true;
		} catch (error) {
			console.error("Failed to clear applications:", error);
			return false;
		}
	}

	/**
	 * Deletes an application.
	 */
	public async delete(appID: ApplicationID): Promise<boolean> {
		const matches = await this.matches(appID);
		const matchingApp = matches?.[0];

		if (!matchingApp) {
			throw new NoAppMatchError();
		}

		try {
			await this._db.deleteApplication(appID);
			this._applications = undefined;
			return true;
		} catch (error) {
			console.error("Failed to delete application:", error);
			return false;
		}
	}

	/**
	 * Edits an existing application.
	 */
	public async edit(
		appID: ApplicationID,
		newApp: Application,
		options?: {
			ignorePassword?: boolean;
		}
	): Promise<boolean> {
		const appIDMatches = await this.matches(appID);
		const appToEdit = appIDMatches?.[0];

		if (!appToEdit) {
			throw new NoAppMatchError();
		}

		if (options?.ignorePassword) {
			newApp = Object.assign({}, newApp, { password: appToEdit.password });
		}

		try {
			await this._db.updateApplication(appID, newApp);
			this._applications = undefined;
			return true;
		} catch (error) {
			console.error("Failed to update application:", error);
			return false;
		}
	}

	/**
	 * Finds applications matching the given identifier.
	 */
	public async matches(appID: ApplicationID): Promise<Array<Application>> {
		const result = await this._db.findApplications(appID);
		return result;
	}

	/**
	 * Returns the application matching the given identifier.
	 */
	public async getMatch(appID: ApplicationID): Promise<Application> {
		const matches = await this.matches(appID);

		if (matches.length === 0) {
			throw new NoAppMatchError();
		}

		return matches[0];
	}

	/**
	 * Creates an application identifier from an application.
	 */
	public appIDFrom(app: Application): ApplicationID {
		return { url: app.url, username: app.username };
	}
}
