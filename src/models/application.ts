export interface Application {
	url: string;
	username: string;
	password: string;
	// Sync configuration
	database: string;
	odooVersion: string;
	autoSync: boolean;
	pollIntervalMinutes: number;
	ntfyUrl: string;
	ntfyTopic: string;
}

export type ApplicationID = Pick<Application, "url" | "username">;
