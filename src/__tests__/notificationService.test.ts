import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockApp, ntfyHolder } = vi.hoisted(() => ({
    mockApp: { addListener: vi.fn() },
    ntfyHolder: { last: undefined as any },
}));

vi.mock("@capacitor/app", () => ({ App: mockApp }));
vi.mock("../services/ntfyService", () => {
    class FakeNtfyService {
        connect = vi.fn();
        disconnect = vi.fn();
        isConnected = false;
        _onMessage?: (title: string) => void;
        constructor() {
            this.connect.mockImplementation((_url: string, _topic: string, cb: any) => {
                this._onMessage = cb;
                this.isConnected = true;
            });
            this.disconnect.mockImplementation(() => { this.isConnected = false; });
            ntfyHolder.last = this;
        }
    }
    return { NtfyService: FakeNtfyService };
});

import { NotificationService } from "../services/notificationService";
import { Events } from "../constants/events";
import { EventBus } from "@odoo/owl";

function fakeApp(over: Partial<any> = {}) {
    return {
        url: "https://odoo",
        username: "u", password: "p", database: "db",
        autoSync: true, pollIntervalMinutes: 5,
        ntfyUrl: "", ntfyTopic: "", ntfyToken: "",
        ...over,
    };
}

let appStateCb: ((s: { isActive: boolean }) => void) | undefined;
let onlineCb: (() => void) | undefined;

function makeServices(apps: any[]) {
    appStateCb = undefined;
    onlineCb = undefined;
    mockApp.addListener.mockImplementation((evt: string, cb: any) => {
        if (evt === "appStateChange") appStateCb = cb;
        return { remove: vi.fn() };
    });

    const appService = { getApps: vi.fn().mockResolvedValue(apps) } as any;
    const syncService = {
        pollForChanges: vi.fn().mockResolvedValue([]),
        syncAll: vi.fn().mockResolvedValue(undefined),
    } as any;
    const bus = new EventBus();
    return { appService, syncService, bus };
}

describe("NotificationService", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal("window", {
            addEventListener: vi.fn((evt: string, cb: any) => {
                if (evt === "online") onlineCb = cb;
            }),
        });
        mockApp.addListener.mockReset();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        ntfyHolder.last = undefined;
    });

    describe("start", () => {
        it("starts a poll timer per autoSync app and registers lifecycle hooks", async () => {
            const { appService, syncService, bus } = makeServices([
                fakeApp({ database: "a", pollIntervalMinutes: 1 }),
                fakeApp({ database: "b", pollIntervalMinutes: 2 }),
                fakeApp({ database: "skipped", autoSync: false }),
                fakeApp({ database: "", autoSync: true }),
                fakeApp({ database: "zero", pollIntervalMinutes: 0 }),
            ]);
            const svc = new NotificationService(syncService, appService, bus);
            svc.start();
            await Promise.resolve(); await Promise.resolve();
            expect(mockApp.addListener).toHaveBeenCalledWith(
                "appStateChange", expect.any(Function),
            );
            expect((window as any).addEventListener).toHaveBeenCalledWith(
                "online", expect.any(Function),
            );

            await vi.advanceTimersByTimeAsync(60_001);
            const usedDbs = syncService.pollForChanges.mock.calls
                .map((c: any) => c[0].database);
            expect(usedDbs).toContain("a");
            expect(usedDbs).not.toContain("b");
            expect(usedDbs).not.toContain("skipped");
        });

        it("emits SYNC_CHANGES_DETECTED when poll returns ids", async () => {
            const { appService, syncService, bus } = makeServices([
                fakeApp({ database: "a", pollIntervalMinutes: 1 }),
            ]);
            syncService.pollForChanges.mockResolvedValueOnce([10, 20]);
            const handler = vi.fn();
            bus.addEventListener(Events.SYNC_CHANGES_DETECTED, handler);

            const svc = new NotificationService(syncService, appService, bus);
            svc.start();
            await Promise.resolve(); await Promise.resolve();
            await vi.advanceTimersByTimeAsync(60_001);
            await Promise.resolve(); await Promise.resolve();

            expect(handler).toHaveBeenCalledTimes(1);
            const ev = handler.mock.calls[0][0] as CustomEvent;
            expect(ev.detail.count).toBe(2);
            expect(ev.detail.odooIds).toEqual([10, 20]);
            expect(ev.detail.creds.database).toBe("a");
        });

        it("connects NTFY for the first app that has url+topic, with token", async () => {
            const { appService, syncService, bus } = makeServices([
                fakeApp({ database: "noNtfy" }),
                fakeApp({
                    database: "withNtfy",
                    ntfyUrl: "https://ntfy.x", ntfyTopic: "T",
                    ntfyToken: "tok",
                }),
            ]);
            const svc = new NotificationService(syncService, appService, bus);
            svc.start();
            await Promise.resolve(); await Promise.resolve();
            expect(ntfyHolder.last.connect).toHaveBeenCalledWith(
                "https://ntfy.x", "T", expect.any(Function), "tok",
            );
        });

        it("connects NTFY without token when token is empty", async () => {
            const { appService, syncService, bus } = makeServices([
                fakeApp({ database: "x", ntfyUrl: "u", ntfyTopic: "t" }),
            ]);
            const svc = new NotificationService(syncService, appService, bus);
            svc.start();
            await Promise.resolve(); await Promise.resolve();
            const callArgs = ntfyHolder.last.connect.mock.calls[0];
            expect(callArgs[3]).toBeUndefined();
        });

        it("does not call NtfyService.connect when no app has NTFY configured", async () => {
            const { appService, syncService, bus } = makeServices([
                fakeApp({ database: "x" }),
            ]);
            const svc = new NotificationService(syncService, appService, bus);
            svc.start();
            await Promise.resolve(); await Promise.resolve();
            expect(ntfyHolder.last.connect).not.toHaveBeenCalled();
        });
    });

    describe("appStateChange", () => {
        it("stops polling and disconnects NTFY when app goes inactive", async () => {
            const { appService, syncService, bus } = makeServices([
                fakeApp({ database: "a", pollIntervalMinutes: 1 }),
            ]);
            const svc = new NotificationService(syncService, appService, bus);
            svc.start();
            await Promise.resolve(); await Promise.resolve();

            appStateCb!({ isActive: false });
            await Promise.resolve();
            expect(ntfyHolder.last.disconnect).toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(120_000);
            expect(syncService.pollForChanges).not.toHaveBeenCalled();
        });

        it("restarts polling and NTFY when app becomes active again", async () => {
            const { appService, syncService, bus } = makeServices([
                fakeApp({
                    database: "a", pollIntervalMinutes: 1,
                    ntfyUrl: "u", ntfyTopic: "t",
                }),
            ]);
            const svc = new NotificationService(syncService, appService, bus);
            svc.start();
            await Promise.resolve(); await Promise.resolve();
            const initialConnects = ntfyHolder.last.connect.mock.calls.length;

            appStateCb!({ isActive: false });
            await Promise.resolve();
            appStateCb!({ isActive: true });
            await Promise.resolve(); await Promise.resolve();

            expect(ntfyHolder.last.connect.mock.calls.length)
                .toBeGreaterThan(initialConnects);
        });
    });

    describe("network restore", () => {
        it("syncs all apps with a database and reloads notes", async () => {
            const { appService, syncService, bus } = makeServices([
                fakeApp({ database: "a" }),
                fakeApp({ database: "" }),
                fakeApp({ database: "c" }),
            ]);
            const handler = vi.fn();
            bus.addEventListener(Events.RELOAD_NOTES, handler);

            const svc = new NotificationService(syncService, appService, bus);
            svc.start();
            await Promise.resolve(); await Promise.resolve();

            onlineCb!();
            for (let i = 0; i < 5; i++) await Promise.resolve();

            expect(syncService.syncAll).toHaveBeenCalledTimes(2);
            expect(handler).toHaveBeenCalledTimes(1);
        });
    });

    describe("NTFY-triggered poll", () => {
        it("calls pollForChanges and emits when ids returned", async () => {
            const { appService, syncService, bus } = makeServices([
                fakeApp({
                    database: "a",
                    ntfyUrl: "u", ntfyTopic: "t",
                    pollIntervalMinutes: 99,
                }),
            ]);
            syncService.pollForChanges.mockResolvedValueOnce([7]);
            const handler = vi.fn();
            bus.addEventListener(Events.SYNC_CHANGES_DETECTED, handler);

            const svc = new NotificationService(syncService, appService, bus);
            svc.start();
            await Promise.resolve(); await Promise.resolve();

            ntfyHolder.last._onMessage!("ignored title");
            for (let i = 0; i < 5; i++) await Promise.resolve();

            expect(syncService.pollForChanges).toHaveBeenCalled();
            expect(handler).toHaveBeenCalledTimes(1);
            expect((handler.mock.calls[0][0] as CustomEvent).detail.odooIds)
                .toEqual([7]);
        });
    });

    describe("reload", () => {
        it("re-reads apps and restarts NTFY with new config", async () => {
            const { appService, syncService, bus } = makeServices([
                fakeApp({ database: "a", ntfyUrl: "", ntfyTopic: "" }),
            ]);
            const svc = new NotificationService(syncService, appService, bus);
            svc.start();
            await Promise.resolve(); await Promise.resolve();
            expect(ntfyHolder.last.connect).not.toHaveBeenCalled();

            appService.getApps.mockResolvedValue([
                fakeApp({ database: "a", ntfyUrl: "u2", ntfyTopic: "t2" }),
            ]);
            await svc.reload();
            await Promise.resolve();
            expect(ntfyHolder.last.connect).toHaveBeenCalledWith(
                "u2", "t2", expect.any(Function), undefined,
            );
        });
    });
});
