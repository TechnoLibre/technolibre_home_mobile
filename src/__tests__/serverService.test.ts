import { describe, it, expect, beforeEach } from "vitest";
import { ServerService } from "../services/serverService";
import { DatabaseService } from "../services/databaseService";
import { Server } from "../models/server";
import { Workspace } from "../models/workspace";
import { ServerAlreadyExistsError, NoServerMatchError } from "../js/errors";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";

describe("ServerService with SQLite", () => {
    let db: DatabaseService;
    let serverService: ServerService;

    const makeServer = (overrides: Partial<Server> = {}): Server => ({
        host: "192.168.1.100",
        port: 22,
        username: "admin",
        authType: "password",
        password: "secret",
        privateKey: "",
        passphrase: "",
        label: "Dev Server",
        deployPath: "~/erplibre",
        ...overrides,
    });

    beforeEach(async () => {
        SecureStoragePlugin._store.clear();
        db = new DatabaseService();
        await db.initialize();
        // Servers and workspaces tables are created by migrations, not initialize()
        await db.createServersTable();
        await db.createServerWorkspacesTable();
        serverService = new ServerService(db);
    });

    // ── getServers ────────────────────────────────────────────────────────────

    describe("getServers", () => {
        it("returns empty list initially", async () => {
            const servers = await serverService.getServers();
            expect(servers).toEqual([]);
        });
    });

    // ── add ───────────────────────────────────────────────────────────────────

    describe("add", () => {
        it("adds a server and returns true", async () => {
            const result = await serverService.add(makeServer());
            expect(result).toBe(true);
            const servers = await serverService.getServers();
            expect(servers).toHaveLength(1);
            expect(servers[0].host).toBe("192.168.1.100");
        });

        it("persists all fields", async () => {
            const s = makeServer({ label: "Prod", port: 2222, authType: "key", deployPath: "/opt/erp" });
            await serverService.add(s);
            const stored = (await serverService.getServers())[0];
            expect(stored.label).toBe("Prod");
            expect(stored.port).toBe(2222);
            expect(stored.authType).toBe("key");
            expect(stored.deployPath).toBe("/opt/erp");
        });

        it("throws ServerAlreadyExistsError on duplicate (host + username)", async () => {
            await serverService.add(makeServer());
            await expect(serverService.add(makeServer())).rejects.toThrow(ServerAlreadyExistsError);
        });

        it("allows two servers with same host but different usernames", async () => {
            await serverService.add(makeServer({ username: "alice" }));
            await serverService.add(makeServer({ username: "bob" }));
            const servers = await serverService.getServers();
            expect(servers).toHaveLength(2);
        });
    });

    // ── delete ────────────────────────────────────────────────────────────────

    describe("delete", () => {
        it("deletes an existing server", async () => {
            await serverService.add(makeServer());
            const result = await serverService.delete({ host: "192.168.1.100", username: "admin" });
            expect(result).toBe(true);
            const servers = await serverService.getServers();
            expect(servers).toEqual([]);
        });

        it("throws NoServerMatchError when server not found", async () => {
            await expect(
                serverService.delete({ host: "unknown", username: "nobody" })
            ).rejects.toThrow(NoServerMatchError);
        });
    });

    // ── edit ──────────────────────────────────────────────────────────────────

    describe("edit", () => {
        it("updates server fields", async () => {
            await serverService.add(makeServer());
            await serverService.edit(
                { host: "192.168.1.100", username: "admin" },
                makeServer({ label: "Updated", port: 2222 })
            );
            const updated = (await serverService.getServers())[0];
            expect(updated.label).toBe("Updated");
            expect(updated.port).toBe(2222);
        });

        it("preserves credentials when ignoreCredential is true", async () => {
            await serverService.add(makeServer({ password: "original" }));
            await serverService.edit(
                { host: "192.168.1.100", username: "admin" },
                makeServer({ password: "new-password", label: "Renamed" }),
                { ignoreCredential: true }
            );
            const updated = (await serverService.getServers())[0];
            expect(updated.label).toBe("Renamed");
            expect(updated.password).toBe("original");
        });

        it("throws NoServerMatchError when server not found", async () => {
            await expect(
                serverService.edit({ host: "unknown", username: "nobody" }, makeServer())
            ).rejects.toThrow(NoServerMatchError);
        });
    });

    // ── matches / getMatch ────────────────────────────────────────────────────

    describe("matches", () => {
        it("returns matching servers", async () => {
            await serverService.add(makeServer());
            const result = await serverService.matches({ host: "192.168.1.100", username: "admin" });
            expect(result).toHaveLength(1);
        });

        it("returns empty array when no match", async () => {
            const result = await serverService.matches({ host: "ghost", username: "nobody" });
            expect(result).toEqual([]);
        });
    });

    describe("getMatch", () => {
        it("returns the matched server", async () => {
            await serverService.add(makeServer({ label: "Target" }));
            const server = await serverService.getMatch({ host: "192.168.1.100", username: "admin" });
            expect(server.label).toBe("Target");
        });

        it("throws NoServerMatchError when not found", async () => {
            await expect(
                serverService.getMatch({ host: "ghost", username: "nobody" })
            ).rejects.toThrow(NoServerMatchError);
        });
    });

    // ── Workspace CRUD ────────────────────────────────────────────────────────

    describe("workspace management", () => {
        const serverID = { host: "192.168.1.100", username: "admin" };
        const makeWorkspace = (path = "~/erplibre"): Workspace => ({
            host: "192.168.1.100",
            username: "admin",
            path,
        });

        beforeEach(async () => {
            await serverService.add(makeServer());
        });

        it("returns empty workspace list initially", async () => {
            const ws = await serverService.getWorkspaces(serverID);
            expect(ws).toEqual([]);
        });

        it("adds a workspace", async () => {
            await serverService.addWorkspace(makeWorkspace());
            const ws = await serverService.getWorkspaces(serverID);
            expect(ws).toHaveLength(1);
            expect(ws[0].path).toBe("~/erplibre");
        });

        it("workspaceExists returns true after add", async () => {
            await serverService.addWorkspace(makeWorkspace());
            const exists = await serverService.workspaceExists(makeWorkspace());
            expect(exists).toBe(true);
        });

        it("workspaceExists returns false for unknown workspace", async () => {
            const exists = await serverService.workspaceExists(makeWorkspace("/opt/other"));
            expect(exists).toBe(false);
        });

        it("deletes a workspace", async () => {
            await serverService.addWorkspace(makeWorkspace());
            await serverService.deleteWorkspace(makeWorkspace());
            const ws = await serverService.getWorkspaces(serverID);
            expect(ws).toEqual([]);
        });

        it("only returns workspaces belonging to the queried server", async () => {
            await serverService.add(makeServer({ host: "10.0.0.1" }));
            await serverService.addWorkspace(makeWorkspace());
            await serverService.addWorkspace({ host: "10.0.0.1", username: "admin", path: "~/other" });
            const ws = await serverService.getWorkspaces(serverID);
            expect(ws).toHaveLength(1);
            expect(ws[0].host).toBe("192.168.1.100");
        });
    });
});
