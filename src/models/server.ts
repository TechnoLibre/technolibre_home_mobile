export interface Server {
    host: string;
    port: number;
    username: string;
    authType: "password" | "key";
    password: string;
    privateKey: string;
    passphrase: string;
    label: string;
    deployPath: string;
}

export type ServerID = Pick<Server, "host" | "username">;
