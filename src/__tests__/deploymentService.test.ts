import { describe, it, expect, beforeEach, vi } from "vitest";
import { DeploymentService } from "../services/deploymentService";
import { ServerService } from "../services/serverService";
import { DatabaseService } from "../services/databaseService";
import { Server } from "../models/server";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";

// Mock SshPlugin — DeploymentService calls it during deployment runs,
// but the tests below focus on state management (create/find/dismiss/registry).
vi.mock("../plugins/sshPlugin", () => ({
    SshPlugin: {
        connect: vi.fn().mockResolvedValue({}),
        execute: vi.fn().mockResolvedValue({ exitCode: 0 }),
        disconnect: vi.fn().mockResolvedValue({}),
        addListener: vi.fn().mockResolvedValue({ remove: vi.fn().mockResolvedValue({}) }),
    },
}));

describe("DeploymentService", () => {
    let db: DatabaseService;
    let serverService: ServerService;
    let deploymentService: DeploymentService;

    const makeServer = (overrides: Partial<Server> = {}): Server => ({
        host: "192.168.1.100",
        port: 22,
        username: "admin",
        authType: "password",
        password: "secret",
        privateKey: "",
        passphrase: "",
        label: "Dev",
        deployPath: "~/erplibre",
        ...overrides,
    });

    beforeEach(async () => {
        SecureStoragePlugin._store.clear();
        db = new DatabaseService();
        await db.initialize();
        await db.createServersTable();
        await db.createServerWorkspacesTable();
        serverService = new ServerService(db);
        deploymentService = new DeploymentService(serverService);
    });

    // ── create ────────────────────────────────────────────────────────────────

    describe("create", () => {
        it("creates a deployment entry with 3 pending steps", () => {
            const server = makeServer();
            const dep = deploymentService.create(server, "~/erplibre");
            expect(dep.host).toBe("192.168.1.100");
            expect(dep.username).toBe("admin");
            expect(dep.path).toBe("~/erplibre");
            expect(dep.done).toBe(false);
            expect(dep.steps).toHaveLength(3);
            dep.steps.forEach((s) => expect(s.status).toBe("pending"));
        });

        it("adds deployment to the registry list", () => {
            const dep = deploymentService.create(makeServer(), "~/erplibre");
            expect(deploymentService.deployments).toContain(dep);
        });

        it("replaces an existing deployment for the same (host, username, path)", () => {
            const server = makeServer();
            deploymentService.create(server, "~/erplibre");
            const dep2 = deploymentService.create(server, "~/erplibre");
            expect(deploymentService.deployments).toHaveLength(1);
            expect(deploymentService.deployments[0]).toBe(dep2);
        });

        it("keeps separate entries for different paths on the same server", () => {
            const server = makeServer();
            deploymentService.create(server, "~/erplibre");
            deploymentService.create(server, "~/erplibre2");
            expect(deploymentService.deployments).toHaveLength(2);
        });
    });

    // ── find ──────────────────────────────────────────────────────────────────

    describe("find", () => {
        it("retrieves a created deployment by key", () => {
            const dep = deploymentService.create(makeServer(), "~/erplibre");
            const found = deploymentService.find("192.168.1.100", "admin", "~/erplibre");
            expect(found).toBe(dep);
        });

        it("returns undefined for unknown key", () => {
            const found = deploymentService.find("ghost", "nobody", "/nowhere");
            expect(found).toBeUndefined();
        });
    });

    // ── getAllForServer ────────────────────────────────────────────────────────

    describe("getAllForServer", () => {
        it("returns all deployments for a given server", () => {
            const server = makeServer();
            deploymentService.create(server, "~/erplibre");
            deploymentService.create(server, "~/erplibre2");
            deploymentService.create(makeServer({ host: "10.0.0.1" }), "~/erplibre");
            const result = deploymentService.getAllForServer("192.168.1.100", "admin");
            expect(result).toHaveLength(2);
        });

        it("returns empty array when server has no deployments", () => {
            const result = deploymentService.getAllForServer("ghost", "nobody");
            expect(result).toEqual([]);
        });
    });

    // ── dismiss ───────────────────────────────────────────────────────────────

    describe("dismiss", () => {
        it("removes the deployment from the registry", () => {
            deploymentService.create(makeServer(), "~/erplibre");
            deploymentService.dismiss("192.168.1.100", "admin", "~/erplibre");
            expect(deploymentService.deployments).toHaveLength(0);
            expect(deploymentService.find("192.168.1.100", "admin", "~/erplibre")).toBeUndefined();
        });

        it("is a no-op when the key does not exist", () => {
            expect(() =>
                deploymentService.dismiss("ghost", "nobody", "/nowhere")
            ).not.toThrow();
        });
    });

    // ── step reset on re-run ──────────────────────────────────────────────────

    describe("step structure", () => {
        it("each step starts with null durationMs and no logs", () => {
            const dep = deploymentService.create(makeServer(), "~/erplibre");
            dep.steps.forEach((s) => {
                expect(s.durationMs).toBeNull();
                expect(s.errorMessage).toBeNull();
                expect(s.logs).toEqual([]);
                expect(s.autoScroll).toBe(true);
            });
        });

        it("step labels are in French deployment order", () => {
            const dep = deploymentService.create(makeServer(), "~/erplibre");
            expect(dep.steps[0].label).toContain("SSH");
            expect(dep.steps[1].label).toContain("Clonage");
            expect(dep.steps[2].label).toContain("make");
        });
    });
});
