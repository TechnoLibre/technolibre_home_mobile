// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Dialog } from "@capacitor/dialog";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Camera } from "@capacitor/camera";
import { Directory, Filesystem } from "@capacitor/filesystem";

import { OptionsChatNotificationsComponent } from "../components/options/chat_notifications/options_chat_notifications_component";
import { fakeChatPushNative, type FakeChatPushNative } from "../__mocks__/chatPushNative";
import { chatSettings } from "../services/chat/chatSettings";

vi.mock("@capacitor/filesystem", () => ({
    Filesystem: { deleteFile: vi.fn().mockResolvedValue(undefined) },
    Directory: { External: "EXTERNAL", Cache: "CACHE", Data: "DATA" },
}));

vi.mock("@capacitor/camera", () => ({
    Camera: { getPhoto: vi.fn() },
    CameraResultType: { Uri: "uri" },
    CameraSource: { Camera: "CAMERA", Photos: "PHOTOS" },
}));

const A = "https://odoo.exemple.test|alice|demo";
const B = "https://bureau.exemple.test|alice|demo";
const C = "https://autre.exemple.test|alice|demo";
const LINK = "erplibre-ntfy:setup?v=1&url=https%3A%2F%2Fntfy.exemple.test&token=tk_exempleexempleexemple&prefix=upab12cd34&cache=43200";

const row = (configId: string, over: Record<string, unknown> = {}) => ({
    configId, ntfyUrl: null, odooNtfyUrl: null, prefix: null, topic: null, endpoint: null, p256dh: null, auth: null,
    vapidKey: null, registeredAt: null, staleEndpoints: [], lockScreen: "hidden_locked", ...over,
});

function setup(rows: any[] = [row(A), row(B, { ntfyUrl: "https://ntfy.exemple.test" }), row(C)]) {
    const store: Record<string, string> = { app_lang: "en" };
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
    });
    const native: FakeChatPushNative = fakeChatPushNative();
    const push = {
        native,
        applyLink: vi.fn(async (ids: string[], _l: any) => ({ ok: true, reason: null, registered: ids })),
        removeNtfy: vi.fn(async () => {}),
        setOdooUrl: vi.fn(async () => {}),
        setLockScreen: vi.fn(async () => {}),
        setLevel: vi.fn(async (_l: number) => {}),
        registrationError: vi.fn((_id: string): string | null => null),
    };
    const chat = {
        push,
        sources: vi.fn().mockResolvedValue(rows.map((r) => ({ configId: r.configId, label: r.configId.split("|")[0].replace("https://", "") }))),
        repo: { pushRows: vi.fn(async () => rows) },
    };
    const c = new (OptionsChatNotificationsComponent as any)();
    Object.defineProperty(c, "chatService", { value: chat });
    c.setup();
    return { c, native, push, chat, rows };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); });
beforeEach(() => {
    (Dialog.confirm as any).mockResolvedValue({ value: true });
    (LocalNotifications.checkPermissions as any).mockResolvedValue({ display: "granted" });
});

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "options", "chat_notifications", "options_chat_notifications_component.ts"), "utf8");

describe("OptionsChatNotificationsComponent", () => {
    it("choosing level 1 asks for the exemption and offers level 3 when refused", async () => {
        const { c, native, push } = setup();
        native.exempt = false;
        await c.load();
        await c.onLevel(1);
        expect(Dialog.confirm).toHaveBeenCalledTimes(1);
        expect(native.callsOf("requestBatteryExemption")).toHaveLength(1);
        expect(push.setLevel).toHaveBeenCalledWith(1);
        expect(c.state.exemptionRefused).toBe(true);
        await c.onUseLevel3();
        expect(push.setLevel).toHaveBeenLastCalledWith(3);
        expect(c.state.exemptionRefused).toBe(false);
        expect(c.state.level).toBe(3);
        expect(source).toContain("chat.push_use_level_3");
        expect(source).toContain("chat.push_exemption_refused");
    });

    it("an exempt app is not asked again", async () => {
        const { c, native, push } = setup();
        native.exempt = true;
        await c.load();
        await c.onLevel(2);
        expect(Dialog.confirm).not.toHaveBeenCalled();
        expect(push.setLevel).toHaveBeenCalledWith(2);
        expect(c.state.exemptionRefused).toBe(false);
    });

    it("levels 1 and 2 are hidden without the realtime build", async () => {
        const { c, native } = setup();
        native.realtime = false;
        await c.load();
        expect(c.levels().map((l: any) => l.value)).toEqual([3, 4, 5]);
        native.realtime = true;
        await c.load();
        expect(c.levels().map((l: any) => l.value)).toEqual([1, 2, 3, 4, 5]);
    });

    it("asks for the notification permission when a level 1 to 4 is chosen, and says when it is refused", async () => {
        const { c, native, push } = setup();
        native.exempt = true;
        (LocalNotifications.checkPermissions as any).mockResolvedValue({ display: "prompt" });
        (LocalNotifications.requestPermissions as any).mockResolvedValue({ display: "denied" });
        await c.load();
        await c.onLevel(4);
        expect(LocalNotifications.requestPermissions).toHaveBeenCalledTimes(1);
        expect(c.state.permDenied).toBe(true);
        expect(push.setLevel).toHaveBeenCalledWith(4);
        await c.onLevel(5);
        expect(LocalNotifications.requestPermissions).toHaveBeenCalledTimes(1);
    });

    it("a pasted link applies to the account and to the others without ntfy", async () => {
        const { c, push } = setup();
        await c.load();
        c.state.accounts.find((a: any) => a.configId === A).paste = ` ${LINK} `;
        await c.onPasteApply(A);
        expect(push.applyLink).toHaveBeenCalledTimes(1);
        const [ids, link] = push.applyLink.mock.calls[0];
        expect(ids).toEqual([A, C]);
        expect(link).toMatchObject({ url: "https://ntfy.exemple.test", prefix: "upab12cd34" });
        expect(c.state.message).toBe("ntfy set up.");
    });

    it("the others are left alone when the box is unchecked", async () => {
        const { c, push } = setup();
        await c.load();
        c.state.applyOthers = false;
        c.state.accounts.find((a: any) => a.configId === A).paste = LINK;
        await c.onPasteApply(A);
        expect(push.applyLink.mock.calls[0][0]).toEqual([A]);
    });

    it("a bad link says why and changes nothing", async () => {
        const { c, native, push } = setup();
        await c.load();
        c.state.accounts.find((a: any) => a.configId === A).paste = "https://ntfy.exemple.test/not-a-link";
        await c.onPasteApply(A);
        expect(push.applyLink).not.toHaveBeenCalled();
        expect(native.callsOf("setNtfy")).toEqual([]);
        expect(c.state.message).toContain("not an ERPLibre ntfy link");
    });

    it("ntfy's refusal is worded with the reason", async () => {
        const { c, push } = setup();
        push.applyLink.mockResolvedValueOnce({ ok: false, reason: "http_refused", registered: [] });
        await c.load();
        c.state.accounts.find((a: any) => a.configId === A).paste = LINK;
        await c.onPasteApply(A);
        expect(c.state.message).toBe("ntfy refused: http not allowed.");
    });

    it("a scanned photo goes through decodeQr", async () => {
        const { c, native, push } = setup();
        (Camera.getPhoto as any).mockResolvedValue({ path: "file:///data/qr.jpg" });
        native.qrText = LINK;
        await c.load();
        await c.onScan(A);
        expect(native.callsOf("decodeQr")).toEqual([{ path: "file:///data/qr.jpg" }]);
        expect(push.applyLink).toHaveBeenCalledTimes(1);
        expect(push.applyLink.mock.calls[0][1]).toMatchObject({ prefix: "upab12cd34" });
    });

    it("a photo without a QR code, or a cancelled one, changes nothing", async () => {
        const { c, native, push } = setup();
        await c.load();
        (Camera.getPhoto as any).mockResolvedValue({ path: "file:///data/qr.jpg" });
        native.qrText = null;
        await c.onScan(A);
        expect(c.state.message).toContain("No QR code");
        (Camera.getPhoto as any).mockRejectedValue(new Error("User cancelled photos app"));
        await c.onScan(A);
        expect(push.applyLink).not.toHaveBeenCalled();
    });

    it("the photo of a QR code and its original are deleted once read, whatever the answer", async () => {
        const { c, native } = setup();
        await c.load();
        const photo = "file:///data/user/0/ca.erplibre.home/cache/JPEG_20261028_101500_123.jpg";
        (Camera.getPhoto as any).mockResolvedValue({ path: photo });
        const deleted = () => (Filesystem.deleteFile as any).mock.calls.map((call: any[]) => call[0]);
        native.qrText = null;
        await c.onScan(A);
        expect(deleted()).toEqual([
            { path: photo },
            { path: "Pictures/JPEG_20261028_101500_123.jpg", directory: Directory.External },
        ]);
        (Filesystem.deleteFile as any).mockClear();
        (Filesystem.deleteFile as any).mockRejectedValue(new Error("File does not exist"));
        native.failNext("decodeQr");
        await c.onScan(A);
        expect(deleted()).toHaveLength(2);
        expect(c.state.message).toBe("The change failed. Try again.");
    });

    it("the account's ntfy line is one sentence of the language", () => {
        expect(source).not.toMatch(/push_account_ntfy'\)"\/> :/);
        expect(source).toContain("t('chat.push_account_ntfy', { url: a.ntfyUrl || t('chat.push_ntfy_none') })");
    });

    it("the status panel says Odoo for an Odoo-direct account Odoo does not answer", async () => {
        const { c, native } = setup();
        await c.load();
        native.health = { accounts: [{ configId: A, via: "odoo", state: "error", reason: "unreachable", lastCheckAt: 0 }] };
        await c.refreshStatus();
        expect(c.statusLines().join("\n")).toContain("Odoo unreachable");
    });

    it("the reason of a failed registration shows under the registration line", async () => {
        const { c, push } = setup();
        push.registrationError.mockImplementation((id: string) => (id === B ? "chat.push_registration_offline" : null));
        await c.load();
        expect(c.state.accounts.map((a: any) => a.registrationError)).toEqual([null, "chat.push_registration_offline", null]);
        const line = source.indexOf("chat.push_not_registered");
        const reason = source.indexOf("t(a.registrationError)");
        expect(line).toBeGreaterThan(0);
        expect(reason).toBeGreaterThan(line);
        expect(source.slice(line, reason)).not.toContain("chat-new__chips");
    });

    it("the lock-screen choice is saved and published", async () => {
        const { c, push } = setup();
        await c.load();
        await c.onLockScreen(A, "never");
        expect(push.setLockScreen).toHaveBeenCalledWith(A, "never");
        expect(c.state.accounts.find((a: any) => a.configId === A).lockScreen).toBe("never");
    });

    it("the Odoo-side URL is saved, and a bad one refused", async () => {
        const { c, push } = setup();
        await c.load();
        await c.onOdooUrl(B, { target: { value: "http://odoo-ntfy.exemple.test:8080" } });
        expect(push.setOdooUrl).toHaveBeenCalledWith(B, "http://odoo-ntfy.exemple.test:8080");
        push.setOdooUrl.mockRejectedValueOnce(new Error("Not an http(s) URL"));
        await c.onOdooUrl(B, { target: { value: "ntfy" } });
        expect(c.state.message).toBe("This is not an http(s) address.");
    });

    it("an ntfy is removed from its account", async () => {
        const { c, push } = setup();
        await c.load();
        await c.onRemove(B);
        expect(push.removeNtfy).toHaveBeenCalledWith(B);
    });

    it("the status panel names the http reason", async () => {
        const { c, native } = setup();
        const ntfy = (reason: string) => ({ url: "http://ntfy.exemple.test:8080", state: "error" as const, reason, lastContactAt: 0, configIds: [B] });
        native.health = { ntfys: [ntfy("http_refused")] };
        await c.refreshStatus();
        const refused = c.statusLines().join("\n");
        native.health = { ntfys: [ntfy("cleartext_blocked")] };
        await c.refreshStatus();
        const blocked = c.statusLines().join("\n");
        expect(refused).toContain("http not allowed");
        expect(blocked).toContain("http blocked by this version of the app");
        expect(refused).not.toBe(blocked);
    });

    it("the status panel polls every 5 s while shown, and stops", async () => {
        vi.useFakeTimers();
        const { c, native } = setup();
        c.startPolling();
        await vi.advanceTimersByTimeAsync(0);
        const first = native.callsOf("status").length;
        expect(first).toBe(1);
        await vi.advanceTimersByTimeAsync(5000);
        expect(native.callsOf("status")).toHaveLength(first + 1);
        await vi.advanceTimersByTimeAsync(10000);
        expect(native.callsOf("status")).toHaveLength(first + 3);
        c.stopPolling();
        await vi.advanceTimersByTimeAsync(20000);
        expect(native.callsOf("status")).toHaveLength(first + 3);
        // a second start does not double the timer
        c.startPolling();
        c.startPolling();
        await vi.advanceTimersByTimeAsync(5000);
        c.stopPolling();
        expect(native.callsOf("status").length).toBe(first + 3 + 2);
    });

    it("« Vérifier maintenant » runs a check then reads the state", async () => {
        const { c, native } = setup();
        await c.onCheckNow();
        expect(native.callsOf("checkNow")).toHaveLength(1);
        expect(native.callsOf("status").length).toBeGreaterThan(0);
    });

    it("level choices are stored for the next visit", async () => {
        const { c, native } = setup();
        native.exempt = true;
        await c.load();
        expect(c.state.level).toBe(chatSettings().notifyLevel);
    });
});
