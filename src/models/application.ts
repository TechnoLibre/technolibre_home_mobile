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
	ntfyToken: string;
}

export type ApplicationID = Pick<Application, "url" | "username">;
