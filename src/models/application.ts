export interface Application {
	url: string;
	username: string;
	password: string;
}

export type ApplicationID = Pick<Application, "url" | "username">;
