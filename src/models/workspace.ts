export interface Workspace {
    host: string;
    username: string;
    path: string;
}

export type WorkspaceID = Workspace; // all three fields form the PK
