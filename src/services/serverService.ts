import { Server, ServerID } from "../models/server";
import { Workspace } from "../models/workspace";
import { ServerAlreadyExistsError, NoServerMatchError } from "../js/errors";
import { DatabaseService } from "./databaseService";

export class ServerService {
    private _db: DatabaseService;

    constructor(db: DatabaseService) {
        this._db = db;
    }

    public async getServers(): Promise<Array<Server>> {
        return this._db.getAllServers();
    }

    public async add(server: Server): Promise<boolean> {
        const matches = await this.matches(this.serverIDFrom(server));

        if (matches.length !== 0) {
            throw new ServerAlreadyExistsError();
        }

        await this._db.addServer(server);
        return true;
    }

    public async delete(serverID: ServerID): Promise<boolean> {
        const matches = await this.matches(serverID);
        const match = matches?.[0];

        if (!match) {
            throw new NoServerMatchError();
        }

        await this._db.deleteServer(match.host, match.username);
        return true;
    }

    public async edit(
        serverID: ServerID,
        newServer: Server,
        options?: { ignoreCredential?: boolean }
    ): Promise<boolean> {
        const matches = await this.matches(serverID);
        const serverToEdit = matches?.[0];

        if (!serverToEdit) {
            throw new NoServerMatchError();
        }

        if (options?.ignoreCredential) {
            newServer = Object.assign({}, newServer, {
                password: serverToEdit.password,
                privateKey: serverToEdit.privateKey,
                passphrase: serverToEdit.passphrase,
            });
        }

        await this._db.updateServer(serverID.host, serverID.username, newServer);
        return true;
    }

    public async matches(serverID: ServerID): Promise<Array<Server>> {
        const list = await this.getServers();
        return list.filter((s) => this.matchesID(serverID, s));
    }

    public async getMatch(serverID: ServerID): Promise<Server> {
        const matches = await this.matches(serverID);

        if (matches.length === 0) {
            throw new NoServerMatchError();
        }

        return matches[0];
    }

    public serverIDFrom(server: Server): ServerID {
        return { host: server.host, username: server.username };
    }

    private matchesID(id: ServerID, server: Server): boolean {
        return id.host === server.host && id.username === server.username;
    }

    // ── Workspace CRUD ────────────────────────────────────────────────────────

    public async getWorkspaces(serverID: ServerID): Promise<Workspace[]> {
        return this._db.getWorkspacesForServer(serverID.host, serverID.username);
    }

    public async addWorkspace(workspace: Workspace): Promise<void> {
        await this._db.addWorkspace(workspace);
    }

    public async deleteWorkspace(workspace: Workspace): Promise<void> {
        await this._db.deleteWorkspace(workspace);
    }

    public async workspaceExists(workspace: Workspace): Promise<boolean> {
        return this._db.workspaceExists(workspace);
    }
}
