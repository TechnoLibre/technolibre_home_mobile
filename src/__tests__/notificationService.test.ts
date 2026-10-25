import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockApp, ntfyHolder, publishPending } = vi.hoisted(() => ({
    mockApp: { addListener: vi.fn(), getState: vi.fn() },
    ntfyHolder: { last: undefined as any },
    publishPending: vi.fn(async () => {}),
}));

vi.mock("@capacitor/app", () => ({ App: mockApp }));
// notificationService ne s'abonne au cycle de vie que sur une plateforme
// native (garde ajoute cote main). Sans ce mock, addListener n'est jamais
// appele et le test attend une fonction qui n'a pas ete enregistree.
vi.mock("@capacitor/core", () => ({
    Capacitor: { isNativePlatform: () => true },
}));
vi.mock("../plugins/chatSocketPlugin", () => ({ nativeTransport: vi.fn() }));
vi.mock("../services/pendingSyncNotice", () => ({ publishPending }));
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
import { ChatLifecycle } from "../services/chat/chatLifecycle";
import { nativeTransport } from "../plugins/chatSocketPlugin";
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
let wifiCb: (() => void) | undefined;
/** Fake NetworkService: online, captures the reconnect callback in onlineCb. */
let network: any;

function makeServices(apps: any[]) {
    appStateCb = undefined;
    onlineCb = undefined;
    wifiCb = undefined;
    network = {
        isOnline: vi.fn().mockResolvedValue(true),
        onReconnect: vi.fn(async (cb: () => void) => { onlineCb = cb; return () => {}; }),
        onWifi: vi.fn(async (cb: () => void) => { wifiCb = cb; return () => {}; }),
    };
    mockApp.addListener.mockImplementation((evt: string, cb: any) => {
        if (evt === "appStateChange") appStateCb = cb;
        return { remove: vi.fn() };
    });

    const appService = { getApps: vi.fn().mockResolvedValue(apps) } as any;
    const syncService = {
        pollForChanges: vi.fn().mockResolvedValue([]),
        syncAll: vi.fn().mockResolvedValue(undefined),
        pendingNoteIds: vi.fn().mockResolvedValue([]),
        hasDueWork: vi.fn().mockResolvedValue(false),
        nextRetryAt: vi.fn().mockResolvedValue(null),
        chat: { flushAll: vi.fn().mockResolvedValue(undefined), reconnectNow: vi.fn() },
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
        mockApp.getState.mockReset();
        mockApp.getState.mockResolvedValue({ isActive: true });
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
            const svc = new NotificationService(syncService, appService, bus, network);
            svc.start();
            await Promise.resolve(); await Promise.resolve();
            expect(mockApp.addListener).toHaveBeenCalledWith(
                "appStateChange", expect.any(Function),
            );
            expect(network.onReconnect).toHaveBeenCalledWith(expect.any(Function));

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

            const svc = new NotificationService(syncService, appService, bus, network);
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
            const svc = new NotificationService(syncService, appService, bus, network);
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
            const svc = new NotificationService(syncService, appService, bus, network);
            svc.start();
            await Promise.resolve(); await Promise.resolve();
            const callArgs = ntfyHolder.last.connect.mock.calls[0];
            expect(callArgs[3]).toBeUndefined();
        });

        it("does not call NtfyService.connect when no app has NTFY configured", async () => {
            const { appService, syncService, bus } = makeServices([
                fakeApp({ database: "x" }),
            ]);
            const svc = new NotificationService(syncService, appService, bus, network);
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
            const svc = new NotificationService(syncService, appService, bus, network);
            svc.start();
            await Promise.resolve(); await Promise.resolve();

            publishPending.mockClear();
            appStateCb!({ isActive: false });
            await Promise.resolve();
            expect(ntfyHolder.last.disconnect).toHaveBeenCalled();
            // Going to the background tells the native job what still waits
            expect(publishPending).toHaveBeenCalledWith(syncService.db, false);

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
            const svc = new NotificationService(syncService, appService, bus, network);
            svc.start();
            await Promise.resolve(); await Promise.resolve();
            const initialConnects = ntfyHolder.last.connect.mock.calls.length;

            appStateCb!({ isActive: false });
            await Promise.resolve();
            appStateCb!({ isActive: true });
            await Promise.resolve(); await Promise.resolve();

            expect(ntfyHolder.last.connect.mock.calls.length)
                .toBeGreaterThan(initialConnects);
            expect(publishPending).toHaveBeenLastCalledWith(syncService.db, true);
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

            const svc = new NotificationService(syncService, appService, bus, network);
            svc.start();
            await Promise.resolve(); await Promise.resolve();

            onlineCb!();
            for (let i = 0; i < 20; i++) await Promise.resolve();

            expect(syncService.syncAll).toHaveBeenCalledTimes(2);
            expect(syncService.syncAll.mock.calls.every((c: any[]) => c[2]?.force === true)).toBe(true);
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it("syncs again an app a later pull queued notes for", async () => {
            const { appService, syncService, bus } = makeServices([
                fakeApp({ database: "a" }),
                fakeApp({ database: "c" }),
            ]);
            const svc = new NotificationService(syncService, appService, bus, network);
            svc.start();
            for (let i = 0; i < 20; i++) await Promise.resolve();
            syncService.pendingNoteIds.mockResolvedValueOnce(["n1"]).mockResolvedValueOnce([]);

            onlineCb!();
            for (let i = 0; i < 20; i++) await Promise.resolve();

            expect(syncService.syncAll).toHaveBeenCalledTimes(3);
            // The second pass waits out retry delays
            expect(syncService.syncAll.mock.calls[2][2]).toEqual({ force: false });
        });
    });

    describe("due work", () => {
        it("syncs at startup only the apps with due work, retry delays respected", async () => {
            const { appService, syncService, bus } = makeServices([
                fakeApp({ database: "a" }),
                fakeApp({ database: "b" }),
            ]);
            syncService.hasDueWork.mockImplementation(async (id: string) => id.endsWith("|b"));
            const handler = vi.fn();
            bus.addEventListener(Events.RELOAD_NOTES, handler);

            new NotificationService(syncService, appService, bus, network).start();
            for (let i = 0; i < 20; i++) await Promise.resolve();

            expect(syncService.syncAll).toHaveBeenCalledTimes(1);
            expect(syncService.syncAll.mock.calls[0][0].database).toBe("b");
            expect(syncService.syncAll.mock.calls[0][2]).toEqual({ force: false });
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it("syncs again a server a later server's pull queued notes for, not one pending for its own reason", async () => {
            const { appService, syncService, bus } = makeServices([
                fakeApp({ database: "a" }),
                fakeApp({ database: "b" }),
            ]);
            syncService.hasDueWork.mockResolvedValue(true);
            // a keeps a held note (h); b's sync pulls a change that queues n1 on a
            const pending: Record<string, string[]> = { a: ["h"], b: [] };
            syncService.pendingNoteIds.mockImplementation(async (id: string) => pending[id.split("|").pop()!]);
            syncService.syncAll.mockImplementation(async (creds: any) => {
                if (creds.database === "b") pending.a = ["h", "n1"];
                if (creds.database === "a" && pending.a.includes("n1")) pending.a = ["h"];
            });

            new NotificationService(syncService, appService, bus, network).start();
            for (let i = 0; i < 40; i++) await Promise.resolve();

            expect(syncService.syncAll.mock.calls.map((c: any[]) => c[0].database)).toEqual(["a", "b", "a"]);
        });

        it("syncs the servers with due work, retry delays respected, when the device moves onto Wi-Fi", async () => {
            const { appService, syncService, bus } = makeServices([fakeApp({ database: "a" }), fakeApp({ database: "b" })]);
            new NotificationService(syncService, appService, bus, network).start();
            for (let i = 0; i < 20; i++) await Promise.resolve();
            expect(syncService.syncAll).not.toHaveBeenCalled();

            syncService.hasDueWork.mockImplementation(async (id: string) => id.endsWith("|a"));
            wifiCb!();
            for (let i = 0; i < 20; i++) await Promise.resolve();
            expect(syncService.syncAll.mock.calls.map((c: any[]) => [c[0].database, c[2]])).toEqual([["a", { force: false }]]);
        });

        it("does not sync a server that was not due for notes it already waited for", async () => {
            const { appService, syncService, bus } = makeServices([fakeApp({ database: "a" }), fakeApp({ database: "b" })]);
            syncService.hasDueWork.mockImplementation(async (id: string) => id.endsWith("|a"));
            syncService.pendingNoteIds.mockImplementation(async (id: string) => (id.endsWith("|b") ? ["waiting"] : []));
            new NotificationService(syncService, appService, bus, network).start();
            for (let i = 0; i < 40; i++) await Promise.resolve();
            expect(syncService.syncAll.mock.calls.map((c: any[]) => c[0].database)).toEqual(["a"]);
        });

        it("runs a flush asked during another once after it, not beside it", async () => {
            const { appService, syncService, bus } = makeServices([fakeApp({ database: "a" })]);
            syncService.hasDueWork.mockResolvedValue(true);
            let release!: () => void;
            syncService.syncAll.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
            new NotificationService(syncService, appService, bus, network).start();
            for (let i = 0; i < 20; i++) await Promise.resolve();
            expect(syncService.syncAll).toHaveBeenCalledTimes(1);

            wifiCb!();
            wifiCb!();
            for (let i = 0; i < 20; i++) await Promise.resolve();
            expect(syncService.syncAll).toHaveBeenCalledTimes(1);
            release();
            for (let i = 0; i < 40; i++) await Promise.resolve();
            expect(syncService.syncAll).toHaveBeenCalledTimes(2);
        });

        it("syncs due work again when the app returns to the foreground", async () => {
            const { appService, syncService, bus } = makeServices([fakeApp({ database: "a" })]);
            new NotificationService(syncService, appService, bus, network).start();
            for (let i = 0; i < 20; i++) await Promise.resolve();
            expect(syncService.syncAll).not.toHaveBeenCalled();

            syncService.hasDueWork.mockResolvedValue(true);
            appStateCb!({ isActive: true });
            for (let i = 0; i < 20; i++) await Promise.resolve();
            expect(syncService.syncAll).toHaveBeenCalledTimes(1);
        });

        it("retries a failed creation at its retry time while the app stays open", async () => {
            const { appService, syncService, bus } = makeServices([fakeApp({ database: "a" })]);
            syncService.nextRetryAt.mockResolvedValue(new Date(Date.now() + 30_000).toISOString());
            new NotificationService(syncService, appService, bus, network).start();
            for (let i = 0; i < 20; i++) await Promise.resolve();
            expect(syncService.syncAll).not.toHaveBeenCalled();

            syncService.hasDueWork.mockResolvedValue(true);
            syncService.nextRetryAt.mockResolvedValue(null);
            await vi.advanceTimersByTimeAsync(29_000);
            expect(syncService.syncAll).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(2_500);
            expect(syncService.syncAll).toHaveBeenCalledTimes(1);
            expect(syncService.syncAll.mock.calls[0][2]).toEqual({ force: false });
        });

        it("network restore reconnects the chat buses and flushes chat, forced, before the notes sync", async () => {
            const { appService, syncService, bus } = makeServices([fakeApp({ database: "a" })]);
            new NotificationService(syncService, appService, bus, network).start();
            for (let i = 0; i < 20; i++) await Promise.resolve();
            syncService.chat.flushAll.mockClear();
            const order: string[] = [];
            syncService.chat.reconnectNow.mockImplementation(() => order.push("reconnect"));
            syncService.chat.flushAll.mockImplementation(async () => { order.push("chat"); });
            syncService.syncAll.mockImplementation(async () => { order.push("notes"); });
            onlineCb!();
            for (let i = 0; i < 40; i++) await Promise.resolve();
            expect(syncService.chat.flushAll).toHaveBeenCalledTimes(1);
            expect(syncService.chat.flushAll).toHaveBeenCalledWith({ force: true });
            expect(order.slice(0, 3)).toEqual(["reconnect", "chat", "notes"]);
        });

        it("a chat flush that throws still arms the retry timer", async () => {
            const { appService, syncService, bus } = makeServices([fakeApp({ database: "a" })]);
            syncService.chat.flushAll.mockRejectedValue(new Error("chat down"));
            new NotificationService(syncService, appService, bus, network).start();
            for (let i = 0; i < 40; i++) await Promise.resolve();
            expect(syncService.nextRetryAt).toHaveBeenCalled();
        });

        it("retry timer counts chat rows: a due chat row is flushed once, the timer is not re-armed", async () => {
            const { appService, syncService, bus } = makeServices([fakeApp({ database: "a" })]);
            // nextRetryAt reads the whole outbox, chat rows included; hasDueWork skips them
            const dueAt = Date.now() + 30_000;
            let failedChatRowAt: string | null = new Date(dueAt).toISOString();
            syncService.nextRetryAt.mockImplementation(async () => failedChatRowAt);
            // The flush drains the row only once it is due (as ChatOutbox.flush does)
            syncService.chat.flushAll.mockImplementation(async () => {
                if (Date.now() >= dueAt) failedChatRowAt = null;
            });
            new NotificationService(syncService, appService, bus, network).start();
            for (let i = 0; i < 20; i++) await Promise.resolve();
            syncService.chat.flushAll.mockClear();

            await vi.advanceTimersByTimeAsync(29_000);
            expect(syncService.chat.flushAll).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(2_500);
            expect(syncService.chat.flushAll).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(10_000);
            expect(syncService.chat.flushAll).toHaveBeenCalledTimes(1);
        });
    });

    describe("ChatLifecycle", () => {
        const fakeChat = () => ({
            startRealtime: vi.fn().mockResolvedValue(undefined),
            stopRealtime: vi.fn(),
            startSourceRealtime: vi.fn().mockResolvedValue(undefined),
            stopSourceRealtime: vi.fn(),
            forgetSource: vi.fn().mockResolvedValue(undefined),
        }) as any;

        it("going inactive stops realtime, active starts it", async () => {
            makeServices([]);
            const chat = fakeChat();
            await new ChatLifecycle(chat).start();
            expect(chat.startRealtime).toHaveBeenCalledTimes(1);
            expect(chat.startRealtime).toHaveBeenCalledWith(nativeTransport);

            appStateCb!({ isActive: false });
            expect(chat.stopRealtime).toHaveBeenCalledTimes(1);
            appStateCb!({ isActive: true });
            expect(chat.startRealtime).toHaveBeenCalledTimes(2);
        });

        it("a cold start in the background opens no socket until the app comes forward", async () => {
            makeServices([]);
            mockApp.getState.mockResolvedValue({ isActive: false });
            const chat = fakeChat();
            await new ChatLifecycle(chat).start();
            expect(chat.startRealtime).not.toHaveBeenCalled();
            appStateCb!({ isActive: true });
            expect(chat.startRealtime).toHaveBeenCalledTimes(1);
        });

        it("a state change reported before the state is read wins over the read", async () => {
            makeServices([]);
            let answer!: (s: { isActive: boolean }) => void;
            mockApp.getState.mockReturnValue(new Promise((r) => { answer = r; }));
            const chat = fakeChat();
            const starting = new ChatLifecycle(chat).start();
            appStateCb!({ isActive: false });
            answer({ isActive: true });
            await starting;
            expect(chat.startRealtime).not.toHaveBeenCalled();
            expect(chat.stopRealtime).toHaveBeenCalledTimes(1);
        });

        it("an application change restarts only its own bus while active, a deletion erases its chat", async () => {
            makeServices([]);
            const chat = fakeChat();
            const order: string[] = [];
            chat.stopSourceRealtime.mockImplementation((id: string) => order.push("stop " + id));
            chat.forgetSource.mockImplementation(async (id: string) => { order.push("forget " + id); });
            chat.startSourceRealtime.mockImplementation(async (id: string) => { order.push("start " + id); });
            const life = new ChatLifecycle(chat);
            await life.start();
            chat.startRealtime.mockClear();
            order.length = 0;
            const id = "https://a|u|db";
            await life.applicationsChanged({ kind: "add", configId: id, realtimeRelevant: true });
            expect(order).toEqual(["start " + id]);
            order.length = 0;
            await life.applicationsChanged({ kind: "edit", configId: id, realtimeRelevant: true });
            expect(order).toEqual(["stop " + id, "start " + id]);
            order.length = 0;
            await life.applicationsChanged({ kind: "edit", configId: "https://a|u|new", previousConfigId: id, realtimeRelevant: true });
            expect(order).toEqual(["stop " + id, "start https://a|u|new"]);
            // autoSync, poll interval and ntfy edits restart no bus
            order.length = 0;
            await life.applicationsChanged({ kind: "edit", configId: id, realtimeRelevant: false });
            expect(order).toEqual([]);
            await life.applicationsChanged({ kind: "delete", configId: id, realtimeRelevant: true });
            expect(order).toEqual(["forget " + id]);
            expect(chat.startRealtime).not.toHaveBeenCalled();
            expect(chat.stopRealtime).not.toHaveBeenCalled();
            // In the background a change starts nothing
            appStateCb!({ isActive: false });
            order.length = 0;
            await life.applicationsChanged({ kind: "edit", configId: id, realtimeRelevant: true });
            expect(order).toEqual(["stop " + id]);
        });

        it("re-arms the retry timer when a row fails elsewhere (a tap on sync)", async () => {
            const { appService, syncService, bus } = makeServices([fakeApp({ database: "a" })]);
            new NotificationService(syncService, appService, bus, network).start();
            for (let i = 0; i < 20; i++) await Promise.resolve();

            syncService.nextRetryAt.mockResolvedValue(new Date(Date.now() + 30_000).toISOString());
            syncService.onRetryScheduled(new Date(Date.now() + 30_000).toISOString());
            for (let i = 0; i < 20; i++) await Promise.resolve();
            syncService.hasDueWork.mockResolvedValue(true);
            syncService.nextRetryAt.mockResolvedValue(null);
            await vi.advanceTimersByTimeAsync(31_500);
            expect(syncService.syncAll).toHaveBeenCalledTimes(1);
        });

        it("arms no timer when the app went to the background while it was computed", async () => {
            const { appService, syncService, bus } = makeServices([fakeApp({ database: "a" })]);
            let release!: (v: string) => void;
            syncService.nextRetryAt.mockReturnValueOnce(new Promise<string>((r) => { release = r; }));
            new NotificationService(syncService, appService, bus, network).start();
            for (let i = 0; i < 20; i++) await Promise.resolve();
            appStateCb!({ isActive: false });
            release(new Date(Date.now() + 30_000).toISOString());
            for (let i = 0; i < 20; i++) await Promise.resolve();
            syncService.hasDueWork.mockResolvedValue(true);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(syncService.syncAll).not.toHaveBeenCalled();
        });

        it("drops the retry timer when the app goes to the background", async () => {
            const { appService, syncService, bus } = makeServices([fakeApp({ database: "a" })]);
            syncService.nextRetryAt.mockResolvedValue(new Date(Date.now() + 30_000).toISOString());
            new NotificationService(syncService, appService, bus, network).start();
            for (let i = 0; i < 20; i++) await Promise.resolve();
            syncService.hasDueWork.mockResolvedValue(true);
            appStateCb!({ isActive: false });
            await vi.advanceTimersByTimeAsync(60_000);
            expect(syncService.syncAll).not.toHaveBeenCalled();
        });

        it("does nothing while offline", async () => {
            const { appService, syncService, bus } = makeServices([fakeApp({ database: "a" })]);
            network.isOnline.mockResolvedValue(false);
            syncService.hasDueWork.mockResolvedValue(true);
            new NotificationService(syncService, appService, bus, network).start();
            for (let i = 0; i < 20; i++) await Promise.resolve();
            expect(syncService.hasDueWork).not.toHaveBeenCalled();
            expect(syncService.syncAll).not.toHaveBeenCalled();
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

            const svc = new NotificationService(syncService, appService, bus, network);
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
            const svc = new NotificationService(syncService, appService, bus, network);
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
