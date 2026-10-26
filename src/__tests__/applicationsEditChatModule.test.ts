// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";

const moduleState = vi.fn();
const installModule = vi.fn();
const upgradeModule = vi.fn();
let isSystem = true;
vi.mock("../services/chat/chatModule", () => ({
    moduleState: (...a: any[]) => moduleState(...a),
    installModule: (...a: any[]) => installModule(...a),
    upgradeModule: (...a: any[]) => upgradeModule(...a),
}));
vi.mock("../services/networkService", () => ({
    networkService: { isOnline: vi.fn().mockResolvedValue(true) },
}));

import { ApplicationsEditComponent } from "../components/applications/edit/applications_edit_component";

function make(version: string) {
    (globalThis as any).localStorage = {
        getItem: (k: string) => (k === "app_lang" ? "en" : null),
        setItem: () => {},
        removeItem: () => {},
    };
    const setSourceState = vi.fn().mockResolvedValue(undefined);
    const app = {
        url: "https://odoo.example.test", username: "alice", password: "pw",
        database: "db1", odooVersion: version, autoSync: false, pollIntervalMinutes: 5,
        ntfyUrl: "", ntfyTopic: "",
    };
    const c = new (ApplicationsEditComponent as any)();
    c.env = {
        router: { getRouteParams: () => new Map([["url", "x"], ["username", "alice"]]) },
        appService: { getMatch: vi.fn().mockResolvedValue(app) },
        syncService: {
            rpc: { sessionInfo: async () => ({ isSystem }) }, capabilities: {},
            chat: { repo: { setSourceState } },
        },
    };
    c.setup();
    return { c, setSourceState };
}

afterEach(() => {
    moduleState.mockReset();
    installModule.mockReset();
    upgradeModule.mockReset();
    isSystem = true;
    delete (globalThis as any).localStorage;
});

describe("ApplicationsEditComponent chat module line", () => {
    it("no line for a non-18 app", async () => {
        const { c } = make("17.0");
        await c.loadAppData();
        expect(moduleState).not.toHaveBeenCalled();
        expect(c.state.chatModule).toBe("");
    });

    it("no line when the version is unknown", async () => {
        const { c } = make("");
        await c.loadAppData();
        expect(moduleState).not.toHaveBeenCalled();
        expect(c.state.chatModule).toBe("");
    });

    it("install button only when available", async () => {
        for (const [st, shown] of [["installed", false], ["available", true], ["absent", false], ["unknown", false]] as const) {
            moduleState.mockResolvedValue(st);
            const { c } = make("18.0");
            await c.loadAppData();
            expect(c.state.chatModule).toBe(st);
            expect(c.state.chatModule === "available").toBe(shown);
        }
    });

    it("a failing probe leaves unknown", async () => {
        moduleState.mockRejectedValue(new Error("boom"));
        const { c } = make("18.0+e");
        await c.loadAppData();
        expect(c.state.chatModule).toBe("unknown");
    });

    it("install updates the line to installed and persists it", async () => {
        moduleState.mockResolvedValue("available");
        installModule.mockResolvedValue({ state: "installed", level: "1.2" });
        const { c, setSourceState } = make("18.0");
        await c.loadAppData();
        await c.installChatModule();
        expect(c.state.chatModule).toBe("installed");
        expect(c.state.chatInstalling).toBe(false);
        expect(c.state.chatError).toBe("");
        expect(setSourceState).toHaveBeenCalledWith({
            configId: "https://odoo.example.test|alice|db1", moduleState: "installed", moduleLevel: "1.2",
        });
    });

    it("an install failure shows an error line and keeps the button", async () => {
        moduleState.mockResolvedValue("available");
        installModule.mockRejectedValue(new Error("nope"));
        const { c, setSourceState } = make("18.0");
        await c.loadAppData();
        await c.installChatModule();
        expect(c.state.chatModule).toBe("available");
        expect(c.state.chatInstalling).toBe(false);
        expect(c.state.chatError).not.toBe("");
        expect(setSourceState).not.toHaveBeenCalled();
    });

    it("upgrade button only for an admin of an outdated module", async () => {
        for (const [admin, shown] of [[true, true], [false, false]] as const) {
            isSystem = admin;
            moduleState.mockResolvedValue("outdated");
            const { c } = make("18.0");
            await c.loadAppData();
            expect(c.state.chatModule).toBe("outdated");
            expect(c.state.chatCanUpgrade).toBe(shown);
        }
        isSystem = true;
        moduleState.mockResolvedValue("installed");
        const { c } = make("18.0");
        await c.loadAppData();
        expect(c.state.chatCanUpgrade).toBe(false);
    });

    it("an admin on a 1.2 server is offered the upgrade", async () => {
        isSystem = true;
        moduleState.mockResolvedValue("outdated");
        const { c } = make("18.0");
        await c.loadAppData();
        expect(c.state.chatCanUpgrade).toBe(true);
    });

    it("an admin on a 1.3 server is offered the upgrade", async () => {
        isSystem = true;
        moduleState.mockResolvedValue("outdated");
        const { c } = make("18.0");
        await c.loadAppData();
        expect(c.state.chatModule).toBe("outdated");
        expect(c.state.chatCanUpgrade).toBe(true);
    });

    it("upgrade updates the line to installed and persists it", async () => {
        moduleState.mockResolvedValue("outdated");
        upgradeModule.mockResolvedValue({ state: "installed", level: "1.4" });
        const { c, setSourceState } = make("18.0");
        await c.loadAppData();
        await c.upgradeChatModule();
        expect(c.state.chatModule).toBe("installed");
        expect(c.state.chatCanUpgrade).toBe(false);
        expect(c.state.chatInstalling).toBe(false);
        expect(setSourceState).toHaveBeenCalledWith({
            configId: "https://odoo.example.test|alice|db1", moduleState: "installed", moduleLevel: "1.4",
        });
    });

    it("a non-admin cannot trigger the upgrade", async () => {
        isSystem = false;
        moduleState.mockResolvedValue("outdated");
        const { c } = make("18.0");
        await c.loadAppData();
        await c.upgradeChatModule();
        expect(upgradeModule).not.toHaveBeenCalled();
    });

    it("an upgrade failure shows an error line and keeps the button", async () => {
        moduleState.mockResolvedValue("outdated");
        upgradeModule.mockRejectedValue(new Error("nope"));
        const { c } = make("18.0");
        await c.loadAppData();
        await c.upgradeChatModule();
        expect(c.state.chatModule).toBe("outdated");
        expect(c.state.chatCanUpgrade).toBe(true);
        expect(c.state.chatError).not.toBe("");
    });
});
