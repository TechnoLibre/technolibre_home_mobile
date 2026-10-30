// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Dialog } from "@capacitor/dialog";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Camera } from "@capacitor/camera";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { App } from "@capacitor/app";

import { OptionsChatNotificationsComponent } from "../components/options/chat_notifications/options_chat_notifications_component";
import { OptionsChatPushAccountComponent } from "../components/options/chat_notifications/options_chat_push_account_component";
import { fakeChatPushNative, type FakeChatPushNative } from "../__mocks__/chatPushNative";
import { chatSettings, setChatSettings, type BrowserMode, type ClimbThreshold, type NotifyLevel } from "../services/chat/chatSettings";
import { t } from "../i18n";
import { translations as fr } from "../i18n/fr";

vi.mock("@capacitor/filesystem", () => ({
    Filesystem: { deleteFile: vi.fn().mockResolvedValue(undefined) },
    Directory: { External: "EXTERNAL", Cache: "CACHE", Data: "DATA" },
}));

vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn(async () => ({ remove: vi.fn(async () => {}) })) } }));

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
    vapidKey: null, registeredAt: null, staleEndpoints: [], lockScreen: "hidden_locked",
    filter: "all", inboxNotify: true, inboxMentions: false, quietOn: false, quietFrom: 1320, quietTo: 420, ...over,
});

function setup(rows: any[] = [row(A), row(B, { ntfyUrl: "https://ntfy.exemple.test" }), row(C)]) {
    const store: Record<string, string> = { app_lang: "en" };
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
    });
    const native: FakeChatPushNative = fakeChatPushNative();
    // The setters write the phone settings as ChatPush does
    const push = {
        native,
        applyLink: vi.fn(async (ids: string[], _l: any) => ({ ok: true, reason: null, registered: ids })),
        removeNtfy: vi.fn(async () => {}),
        setOdooUrl: vi.fn(async () => {}),
        setLockScreen: vi.fn(async () => {}),
        setLevel: vi.fn(async (l: NotifyLevel) => { setChatSettings({ ...chatSettings(), notifyLevel: l }); }),
        setFilter: vi.fn(async (_id: string, _f: string, _i: boolean, _m: boolean) => {}),
        setQuietHours: vi.fn(async (_id: string, _q: { on: boolean; from: number; to: number }) => {}),
        setClimb: vi.fn(async (c: { auto: boolean; oneBelow: ClimbThreshold; twoBelow: ClimbThreshold }) => {
            setChatSettings({ ...chatSettings(), climbAuto: c.auto, climbOneBelow: c.oneBelow, climbTwoBelow: c.twoBelow });
        }),
        setBrowserMode: vi.fn(async (m: BrowserMode) => { setChatSettings({ ...chatSettings(), browserMode: m }); }),
        markOwed: vi.fn((_id: string) => false),
        registrationError: vi.fn((_id: string): string | null => null),
    };
    const appPush = new Set<string>();
    const pushFlags = new Set<string>();
    const chat = {
        push,
        sources: vi.fn().mockResolvedValue(rows.map((r) => ({ configId: r.configId, label: r.configId.split("|")[0].replace("https://", "") }))),
        repo: { pushRows: vi.fn(async () => rows) },
        features: vi.fn(async (id: string) => ({ appPush: appPush.has(id) || pushFlags.has(id), pushFlags: pushFlags.has(id) })),
    };
    const c = new (OptionsChatNotificationsComponent as any)();
    Object.defineProperty(c, "chatService", { value: chat });
    c.setup();
    return { c, native, push, chat, rows, appPush, pushFlags };
}

/** The account card of configId as the screen hands it its props, set up. */
function account(c: any, configId: string): any {
    const card = c.state.accounts.find((a: any) => a.configId === configId);
    const k = new (OptionsChatPushAccountComponent as any)();
    k.props = { card, push: c.chatService.push, native: c.chatService.push.native, pushFlags: card.pushFlags };
    k.setup();
    return k;
}

/** The appStateChange listener the screen registered last. */
function resumeListener(): (s: { isActive: boolean }) => Promise<void> | void {
    return (App.addListener as any).mock.calls.filter((x: any[]) => x[0] === "appStateChange").at(-1)[1];
}

/**
 * Holds every call of a push setter until released, first call first, as
 * ChatPush's queue settles them. Each `release(fail)` settles the oldest
 * held call, rejected when `fail` is set, after running `then` on success.
 */
function holdCalls(setter: any, then: (...args: any[]) => void = () => {}): { release: (fail?: boolean) => Promise<void> } {
    const held: { args: any[]; settle: (fail: boolean) => void }[] = [];
    setter.mockImplementation((...args: any[]) => new Promise<void>((resolve, reject) => {
        held.push({ args, settle: (fail) => (fail ? reject(new Error("refused")) : (then(...args), resolve())) });
    }));
    return {
        release: async (fail = false) => {
            held.shift()!.settle(fail);
            await new Promise((r) => setTimeout(r, 0));
        },
    };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); });
beforeEach(() => {
    (Dialog.confirm as any).mockResolvedValue({ value: true });
    (LocalNotifications.checkPermissions as any).mockResolvedValue({ display: "granted" });
});

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "components", "options", "chat_notifications");
const source = readFileSync(resolve(DIR, "options_chat_notifications_component.ts"), "utf8");
const cardSource = readFileSync(resolve(DIR, "options_chat_push_account_component.ts"), "utf8");

describe("OptionsChatNotificationsComponent", () => {
    it("the actions line says whether 👍 is there", async () => {
        const { c, appPush } = setup();
        appPush.add(B);
        await c.load();
        const of = (id: string) => c.state.accounts.find((a: any) => a.configId === id);
        expect(of(B).appPush).toBe(true);
        expect(of(A).appPush).toBe(false);
        expect(source).toContain("chat.push_actions_full");
        expect(source).toContain("chat.push_actions_no_react");
        expect(t("chat.push_actions_full")).toContain("👍");
        expect(t("chat.push_actions_no_react")).toContain("1.5");
        expect(t("chat.push_actions_full")).not.toBe(t("chat.push_actions_no_react"));
    });

    it("the direct exemption request asks no in-app question first", async () => {
        const { c, native, push } = setup();
        native.exempt = false;
        await c.load();
        await c.onLevel(1);
        expect(Dialog.confirm).not.toHaveBeenCalled();
        expect(native.callsOf("requestBatteryExemption")).toHaveLength(1);
        expect(push.setLevel).toHaveBeenCalledWith(1);
        // The system dialog is still open: nothing is concluded before the app resumes
        expect(c.state.exemptionRefused).toBe(false);
        expect(source).not.toContain("Dialog.confirm");
        expect("chat.push_exemption_ask" in fr).toBe(false);
    });

    it("a refused exemption is shown only once the app resumes not exempt", async () => {
        const { c, native, push } = setup();
        native.exempt = false;
        await c.load();
        // Not asked yet in this screen: a resume shows nothing
        await resumeListener()({ isActive: true });
        expect(c.state.exemptionRefused).toBe(false);
        await c.onLevel(2);
        await resumeListener()({ isActive: false });
        expect(c.state.exemptionRefused).toBe(false);
        const reads = native.callsOf("batteryExempt").length;
        await resumeListener()({ isActive: true });
        expect(native.callsOf("batteryExempt").length).toBe(reads + 1);
        expect(c.state.exemptionRefused).toBe(true);
        await c.onUseLevel3();
        expect(push.setLevel).toHaveBeenLastCalledWith(3);
        expect(c.state.level).toBe(3);
        expect(c.state.exemptionRefused).toBe(false);
        // Level 3 needs no exemption: a later resume shows nothing
        await resumeListener()({ isActive: true });
        expect(c.state.exemptionRefused).toBe(false);
        expect(source).toContain("chat.push_use_level_3");
        expect(source).toContain("chat.push_exemption_refused");
    });

    it("returning exempt hides the refusal", async () => {
        const { c, native } = setup();
        native.exempt = false;
        await c.load();
        await c.onLevel(1);
        await resumeListener()({ isActive: true });
        expect(c.state.exemptionRefused).toBe(true);
        native.exempt = true;
        await resumeListener()({ isActive: true });
        expect(c.state.exemptionRefused).toBe(false);
        // The read on mount follows the exemption as well
        native.exempt = false;
        await c.load();
        expect(c.state.exemptionRefused).toBe(true);
    });

    it("without the realtime build no refusal is shown", async () => {
        const { c, native } = setup();
        native.exempt = false;
        await c.load();
        await c.onLevel(1);
        native.realtime = false;
        await c.load();
        await resumeListener()({ isActive: true });
        expect(c.state.exemptionRefused).toBe(false);
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
        await account(c, A).onLockScreen("never");
        expect(push.setLockScreen).toHaveBeenCalledWith(A, "never");
        expect(c.state.accounts.find((a: any) => a.configId === A).lockScreen).toBe("never");
    });

    it("the filter, inbox and record-mentions switches reach the push service", async () => {
        const { c, push } = setup([row(A), row(B, { ntfyUrl: "https://ntfy.exemple.test", filter: "none", inboxNotify: false, inboxMentions: true })]);
        await c.load();
        const of = (id: string) => c.state.accounts.find((a: any) => a.configId === id);
        expect(of(B)).toMatchObject({ filter: "none", inboxNotify: false, inboxMentions: true });
        expect(of(A)).toMatchObject({ filter: "all", inboxNotify: true, inboxMentions: false });
        const k = account(c, A);
        await k.onFilter("mentions_dm");
        expect(push.setFilter).toHaveBeenLastCalledWith(A, "mentions_dm", true, false);
        await k.onInbox({ target: { checked: false } });
        expect(push.setFilter).toHaveBeenLastCalledWith(A, "mentions_dm", false, false);
        await k.onInboxMentions({ target: { checked: true } });
        expect(push.setFilter).toHaveBeenLastCalledWith(A, "mentions_dm", false, true);
        expect(of(A)).toMatchObject({ filter: "mentions_dm", inboxNotify: false, inboxMentions: true });
        // A refused save leaves the card as it was
        push.setFilter.mockRejectedValueOnce(new Error("ChatPushPlugin.publishSettings: refused"));
        await k.onFilter("none");
        expect(of(A).filter).toBe("mentions_dm");
        expect(k.state.message).toBe(t("chat.push_action_failed"));
        expect(k.filterChoices.map((f: any) => fr[f.label as keyof typeof fr])).toEqual([
            "Tout ce qu'Odoo envoie", "Mentions et messages directs", "Rien de ce serveur",
        ]);
        expect(fr["chat.push_inbox"]).toBe("Boîte de réception (enregistrements et activités)");
        expect(fr["chat.push_filter_approx"]).toBe("filtre approximatif sans le module 1.6");
        expect(cardSource).toMatch(/t-if="!props\.pushFlags"[^>]*t-esc="t\('chat\.push_filter_approx'\)"/);
    });

    it("the record-mentions switch shows only while the inbox is off", () => {
        expect(fr["chat.push_inbox_mentions"]).toBe("Sonner quand même si on me mentionne dans un enregistrement");
        expect(fr["chat.push_inbox_mentions_help"]).toBe("avec le module 1.6");
        const open = cardSource.indexOf('<t t-if="!props.card.inboxNotify">');
        const close = cardSource.indexOf("</t>", open);
        expect(open).toBeGreaterThan(0);
        const block = cardSource.slice(open, close);
        expect(block).toContain("t('chat.push_inbox_mentions')");
        expect(block).toContain("t('chat.push_inbox_mentions_help')");
        expect(cardSource.split("chat.push_inbox_mentions'").length).toBe(2);
    });

    it("quiet hours are saved and equal bounds are refused", async () => {
        const { c, push } = setup();
        await c.load();
        const k = account(c, B);
        expect(k.timeOf(1320)).toBe("22:00");
        expect(k.quietSpan()).toBe("from 22:00 to 07:00");
        await k.onQuietOn({ target: { checked: true } });
        expect(push.setQuietHours).toHaveBeenLastCalledWith(B, { on: true, from: 1320, to: 420 });
        await k.onQuietFrom({ target: { value: "21:30" } });
        expect(push.setQuietHours).toHaveBeenLastCalledWith(B, { on: true, from: 1290, to: 420 });
        push.setQuietHours.mockClear();
        await k.onQuietTo({ target: { value: "21:30" } });
        await k.onQuietTo({ target: { value: "" } });
        expect(push.setQuietHours).not.toHaveBeenCalled();
        expect(k.state.message).toBe(t("chat.push_quiet_equal"));
        expect(c.state.accounts.find((a: any) => a.configId === B)).toMatchObject({ quietOn: true, quietFrom: 1290, quietTo: 420 });
        // Off, equal bounds are no span to refuse
        await k.onQuietOn({ target: { checked: false } });
        expect(push.setQuietHours).toHaveBeenLastCalledWith(B, { on: false, from: 1290, to: 420 });
        expect(fr["chat.push_quiet"]).toBe("Heures calmes");
        expect(fr["chat.push_quiet_span"]).toBe("de {from} à {to}");
        expect(cardSource.match(/<input type="time" class=/g)).toHaveLength(2);
    });

    it("the climbing switch and thresholds are saved", async () => {
        const { c, push } = setup();
        await c.load();
        expect(c.state.climb).toEqual({ auto: true, oneBelow: 30, twoBelow: 15 });
        await c.onClimbAuto({ target: { checked: false } });
        expect(push.setClimb).toHaveBeenLastCalledWith({ auto: false, oneBelow: 30, twoBelow: 15 });
        await c.onClimbOne({ target: { value: "40" } });
        expect(push.setClimb).toHaveBeenLastCalledWith({ auto: false, oneBelow: 40, twoBelow: 15 });
        await c.onClimbTwo({ target: { value: "0" } });
        expect(push.setClimb).toHaveBeenLastCalledWith({ auto: false, oneBelow: 40, twoBelow: 0 });
        expect(c.state.climb).toEqual({ auto: false, oneBelow: 40, twoBelow: 0 });
        push.setClimb.mockClear();
        await c.onClimbTwo({ target: { value: "12" } });
        expect(push.setClimb).not.toHaveBeenCalled();
        expect(c.thresholds().map((x: any) => x.value)).toEqual([0, 10, 15, 20, 30, 40, 50]);
        expect(c.thresholds()[0].label).toBe(t("chat.push_climb_none"));
        expect(c.thresholds()[1].label).toBe("10 %");
        expect([fr["chat.push_climb_auto"], fr["chat.push_climb_one"], fr["chat.push_climb_two"], fr["chat.push_climb_none"]])
            .toEqual(["Économiser automatiquement", "Un niveau de plus sous", "Deux niveaux de plus sous", "aucun"]);
    });

    it("a card change made while another is saved keeps both", async () => {
        const { c, push } = setup();
        await c.load();
        const of = (id: string) => c.state.accounts.find((a: any) => a.configId === id);
        const k = account(c, A);
        const filter = holdCalls(push.setFilter);
        const first = k.onFilter("mentions_dm");
        const second = k.onInbox({ target: { checked: false } });
        expect(push.setFilter).toHaveBeenLastCalledWith(A, "mentions_dm", false, false);
        await filter.release();
        await filter.release();
        await Promise.all([first, second]);
        expect(of(A)).toMatchObject({ filter: "mentions_dm", inboxNotify: false, inboxMentions: false });
        // A refused change, once settled, is no base for the next one
        const refused = k.onFilter("none");
        await filter.release(true);
        await refused;
        expect(of(A).filter).toBe("mentions_dm");
        const next = k.onInboxMentions({ target: { checked: true } });
        expect(push.setFilter).toHaveBeenLastCalledWith(A, "mentions_dm", false, true);
        await filter.release();
        await next;

        const quiet = holdCalls(push.setQuietHours);
        const on = k.onQuietOn({ target: { checked: true } });
        const from = k.onQuietFrom({ target: { value: "21:30" } });
        expect(push.setQuietHours).toHaveBeenLastCalledWith(A, { on: true, from: 1290, to: 420 });
        // Equal bounds are judged against the span asked for, not the one saved
        const equal = k.onQuietTo({ target: { value: "21:30" } });
        expect(push.setQuietHours).toHaveBeenCalledTimes(2);
        expect(k.state.message).toBe(t("chat.push_quiet_equal"));
        await quiet.release();
        await quiet.release();
        await Promise.all([on, from, equal]);
        expect(of(A)).toMatchObject({ quietOn: true, quietFrom: 1290, quietTo: 420 });
    });

    it("a climb change made while another is saved keeps both", async () => {
        const { c, push } = setup();
        await c.load();
        const climb = holdCalls(push.setClimb, (v: any) => {
            setChatSettings({ ...chatSettings(), climbAuto: v.auto, climbOneBelow: v.oneBelow, climbTwoBelow: v.twoBelow });
        });
        const one = c.onClimbOne({ target: { value: "40" } });
        const two = c.onClimbTwo({ target: { value: "0" } });
        expect(push.setClimb).toHaveBeenLastCalledWith({ auto: true, oneBelow: 40, twoBelow: 0 });
        await climb.release();
        await climb.release();
        await Promise.all([one, two]);
        expect(c.state.climb).toEqual({ auto: true, oneBelow: 40, twoBelow: 0 });
        const refused = c.onClimbAuto({ target: { checked: false } });
        await climb.release(true);
        await refused;
        expect(c.state.climb.auto).toBe(true);
        const next = c.onClimbTwo({ target: { value: "10" } });
        expect(push.setClimb).toHaveBeenLastCalledWith({ auto: true, oneBelow: 40, twoBelow: 10 });
        await climb.release();
        await next;
    });

    it("the browser mode is saved and each card says what applies", async () => {
        const { c, push, appPush, pushFlags } = setup();
        pushFlags.add(A);
        appPush.add(B);
        await c.load();
        expect(c.state.browserMode).toBe("wait");
        expect(c.state.accounts.map((a: any) => a.pushFlags)).toEqual([true, false, false]);
        const applies = (mode: string) => t("chat.push_browser_applies", { mode: t(`chat.push_browser_${mode}`) });
        // wait: the hold needs 1.6; 1.5 and no module ring at once
        expect(account(c, A).browserLines()).toEqual([applies("wait")]);
        expect(account(c, B).browserLines()).toEqual([applies("ring")]);
        expect(account(c, C).browserLines()).toEqual([applies("ring")]);
        await c.onBrowserMode("quiet");
        expect(push.setBrowserMode).toHaveBeenCalledWith("quiet");
        expect(c.state.browserMode).toBe("quiet");
        expect(account(c, A).browserLines()).toEqual([applies("quiet")]);
        expect(account(c, B).browserLines()).toEqual([t("chat.push_browser_quiet_15")]);
        expect(account(c, B).browserLines()[0]).toContain("30 min");
        expect(account(c, C).browserLines()).toEqual([applies("ring")]);
        push.markOwed.mockImplementation((id: string) => id === A);
        expect(account(c, A).browserLines()).toEqual([applies("quiet"), t("chat.push_browser_owed")]);
        expect(c.browserChoices.map((b: any) => fr[b.label as keyof typeof fr])).toEqual([
            "Sonner tout de suite", "Attendre 10 s", "Ne pas envoyer au téléphone",
        ]);
        expect(fr["chat.push_browser_owed"]).toBe("pas encore appliqué sur ce serveur");
        expect(fr["chat.push_browser_quiet_15"])
            .toBe("Ne pas envoyer : sur ce serveur (module 1.5), jusqu'à 30 min après votre dernière activité dans le navigateur");
        // A refused mirror is said, the cards still follow the mode the settings hold
        push.setBrowserMode.mockRejectedValueOnce(new Error("ChatPushPlugin.publishSettings: refused"));
        await c.onBrowserMode("ring");
        expect(c.state.message).toBe(t("chat.push_action_failed"));
    });

    it("the effective level and its reason are shown when climbed", async () => {
        const { c, native } = setup();
        await c.load();
        native.health = { level: 1, effectiveLevel: 3, climbReason: "below_two" };
        await c.refreshStatus();
        expect(c.effectiveLine()).toBe(t("chat.push_effective", { level: "3", why: t("chat.push_effective_below", { pct: "15" }) }));
        native.health = { level: 1, effectiveLevel: 2, climbReason: "below_one" };
        await c.refreshStatus();
        expect(c.effectiveLine()).toContain("30 %");
        localStorage.setItem("app_lang", "fr");
        native.health = { level: 1, effectiveLevel: 3, climbReason: "saver" };
        await c.refreshStatus();
        expect(c.effectiveLine()).toBe("En ce moment : niveau 3 (économiseur de batterie)");
        native.health = { level: 1, effectiveLevel: 3, climbReason: "below_two" };
        await c.refreshStatus();
        expect(c.effectiveLine()).toBe("En ce moment : niveau 3 (batterie sous 15 %)");
        expect(source).toContain("effectiveLine()");
    });

    it("no status line when effective differs without a climb reason", async () => {
        const { c, native } = setup();
        await c.load();
        native.realtime = false;
        native.health = { level: 1, effectiveLevel: 3, climbReason: null };
        await c.refreshStatus();
        expect(c.effectiveLine()).toBeNull();
        c.state.health = null;
        expect(c.effectiveLine()).toBeNull();
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
