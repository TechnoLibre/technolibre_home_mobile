import { describe, it, expect, vi, beforeEach } from "vitest";

// vitest.config.ts aliases @capacitor/core to src/__mocks__, whose
// registerPlugin resolves each method against __setPluginMock.
import { __setPluginMock, __clearPluginMocks } from "@capacitor/core";
import { EventBus } from "@odoo/owl";
import { Events } from "../constants/events";
import { t } from "../i18n";
import {
    ERROR_KEEP_AWAKE_NOT_STORED,
    NOTICE_KEEP_AWAKE_TURNED_ON,
    NOTICE_WAKE_OFF_AT_BOOT,
    NOTICE_WAKE_TURNED_OFF,
    WAKE_ON_KEY_PRESS_KEY,
    applyDeckSleepChange,
    deckSleepEffects,
    planDeckSleepChange,
    restoreDeckSleepAtBoot,
    restoreDeckSleepSettings,
    storedWakeOnKeyPress,
    type DeckSleepEffects,
    type DeckSleepSettings,
} from "../services/deckSleepCoupling";
import { streamDeckEventLog } from "../services/streamDeckEventLog";
import { translations as en } from "../i18n/en";
import { translations as fr } from "../i18n/fr";

const ON_OFF = [true, false];

function settings(wakeOnKeyPress: boolean, keepAwake: boolean): DeckSleepSettings {
    return { wakeOnKeyPress, keepAwake };
}

/** Effects that record each write and store keepAwake as asked. */
function recordingEffects(showOverLockScreen = false) {
    const calls: string[] = [];
    const effects: DeckSleepEffects = {
        setKeepAwake: vi.fn(async (enabled: boolean) => {
            calls.push(`keepAwake=${enabled}`);
            return { showOverLockScreen, keepAwake: enabled };
        }),
        setWakeOnKeyPress: vi.fn(async (enabled: boolean) => {
            calls.push(`wakeOnKeyPress=${enabled}`);
        }),
    };
    return { calls, effects };
}

function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
    const store = new Map(Object.entries(initial));
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
    });
    return store;
}

describe("planDeckSleepChange", () => {
    it("turns keepAwake on with wake-on-key-press, and says so", () => {
        const plan = planDeckSleepChange(settings(false, false), {
            setting: "wakeOnKeyPress", enabled: true,
        });
        expect(plan.next).toEqual(settings(true, true));
        expect(plan.coupled).toEqual({ setting: "keepAwake", enabled: true });
        expect(plan.notice).toBe(NOTICE_KEEP_AWAKE_TURNED_ON);
    });

    it("turns wake-on-key-press off with keepAwake, and says so", () => {
        const plan = planDeckSleepChange(settings(true, true), {
            setting: "keepAwake", enabled: false,
        });
        expect(plan.next).toEqual(settings(false, false));
        expect(plan.coupled).toEqual({ setting: "wakeOnKeyPress", enabled: false });
        expect(plan.notice).toBe(NOTICE_WAKE_TURNED_OFF);
    });

    it("leaves keepAwake alone when it is already on", () => {
        const plan = planDeckSleepChange(settings(false, true), {
            setting: "wakeOnKeyPress", enabled: true,
        });
        expect(plan.next).toEqual(settings(true, true));
        expect(plan.coupled).toBeNull();
        expect(plan.notice).toBeNull();
    });

    it("leaves wake-on-key-press alone when it is already off", () => {
        const plan = planDeckSleepChange(settings(false, true), {
            setting: "keepAwake", enabled: false,
        });
        expect(plan.next).toEqual(settings(false, false));
        expect(plan.coupled).toBeNull();
        expect(plan.notice).toBeNull();
    });

    it.each(ON_OFF)("turning wake-on-key-press off keeps keepAwake=%s", (keepAwake) => {
        const plan = planDeckSleepChange(settings(true, keepAwake), {
            setting: "wakeOnKeyPress", enabled: false,
        });
        expect(plan.next).toEqual(settings(false, keepAwake));
        expect(plan.coupled).toBeNull();
        expect(plan.notice).toBeNull();
    });

    it.each(ON_OFF)("turning keepAwake on keeps wake-on-key-press=%s", (wake) => {
        const plan = planDeckSleepChange(settings(wake, false), {
            setting: "keepAwake", enabled: true,
        });
        expect(plan.next).toEqual(settings(wake, true));
        expect(plan.coupled).toBeNull();
        expect(plan.notice).toBeNull();
    });
});

describe("applyDeckSleepChange", () => {
    it("stores keepAwake on before it turns wake-on-key-press on", async () => {
        const { calls, effects } = recordingEffects(true);
        const r = await applyDeckSleepChange(settings(false, false), {
            setting: "wakeOnKeyPress", enabled: true,
        }, effects);
        expect(calls).toEqual(["keepAwake=true", "wakeOnKeyPress=true"]);
        expect(r.settings).toEqual(settings(true, true));
        expect(r.power).toEqual({ showOverLockScreen: true, keepAwake: true });
        expect(r.notice).toBe(NOTICE_KEEP_AWAKE_TURNED_ON);
        expect(r.coupledError).toBeNull();
    });

    it("turns wake-on-key-press off before it stores keepAwake off", async () => {
        const { calls, effects } = recordingEffects();
        const r = await applyDeckSleepChange(settings(true, true), {
            setting: "keepAwake", enabled: false,
        }, effects);
        expect(calls).toEqual(["wakeOnKeyPress=false", "keepAwake=false"]);
        expect(r.settings).toEqual(settings(false, false));
        expect(r.notice).toBe(NOTICE_WAKE_TURNED_OFF);
    });

    it("writes only the setting asked when nothing is coupled", async () => {
        const { calls, effects } = recordingEffects();
        const r = await applyDeckSleepChange(settings(true, true), {
            setting: "wakeOnKeyPress", enabled: false,
        }, effects);
        expect(calls).toEqual(["wakeOnKeyPress=false"]);
        expect(r.settings).toEqual(settings(false, true));
        expect(r.power).toBeUndefined();
        expect(r.notice).toBeNull();
    });

    it("rejects when the setting asked is refused, its dependant already off", async () => {
        const { calls, effects } = recordingEffects();
        effects.setKeepAwake = vi.fn().mockRejectedValue(new Error("refused"));
        await expect(applyDeckSleepChange(settings(true, true), {
            setting: "keepAwake", enabled: false,
        }, effects)).rejects.toThrow("refused");
        expect(calls).toEqual(["wakeOnKeyPress=false"]);
    });

    it("leaves wake-on-key-press off when keepAwake is refused", async () => {
        const { effects } = recordingEffects();
        effects.setKeepAwake = vi.fn().mockRejectedValue(new Error("no plugin"));
        const r = await applyDeckSleepChange(settings(false, false), {
            setting: "wakeOnKeyPress", enabled: true,
        }, effects);
        expect(effects.setWakeOnKeyPress).not.toHaveBeenCalled();
        expect(r.settings).toEqual(settings(false, false));
        expect(r.notice).toBeNull();
        expect(r.coupledError).toContain("no plugin");
    });

    it("leaves wake-on-key-press off when the plugin stores keepAwake off", async () => {
        const { effects } = recordingEffects();
        effects.setKeepAwake = vi.fn().mockResolvedValue({
            showOverLockScreen: false, keepAwake: false,
        });
        const r = await applyDeckSleepChange(settings(false, false), {
            setting: "wakeOnKeyPress", enabled: true,
        }, effects);
        expect(effects.setWakeOnKeyPress).not.toHaveBeenCalled();
        expect(r.settings).toEqual(settings(false, false));
        expect(r.power).toEqual({ showOverLockScreen: false, keepAwake: false });
        expect(r.notice).toBeNull();
        expect(r.coupledError).toBe(t(ERROR_KEEP_AWAKE_NOT_STORED));
    });
});

describe("restoreDeckSleepSettings", () => {
    it.each(ON_OFF)("arms wake-on-key-press=%s as stored when keepAwake is on", async (wake) => {
        const { calls, effects } = recordingEffects();
        const r = await restoreDeckSleepSettings(settings(wake, true), effects);
        expect(calls).toEqual([`wakeOnKeyPress=${wake}`]);
        expect(r.settings).toEqual(settings(wake, true));
        expect(r.notice).toBeNull();
    });

    it("disarms wake-on-key-press stored off with keepAwake off", async () => {
        const { calls, effects } = recordingEffects();
        const r = await restoreDeckSleepSettings(settings(false, false), effects);
        expect(calls).toEqual(["wakeOnKeyPress=false"]);
        expect(r.settings).toEqual(settings(false, false));
    });

    it("turns wake-on-key-press stored on without keepAwake off, and says so", async () => {
        const { calls, effects } = recordingEffects();
        const r = await restoreDeckSleepSettings(settings(true, false), effects);
        expect(calls).toEqual(["wakeOnKeyPress=false"]);
        expect(effects.setKeepAwake).not.toHaveBeenCalled();
        expect(r.settings).toEqual(settings(false, false));
        expect(r.notice).toBe(NOTICE_WAKE_OFF_AT_BOOT);
        expect(r.coupledError).toBeNull();
    });

    it.each([
        settings(true, true), settings(false, true), settings(false, false),
    ])("leaves a coupled pair %o as stored, with no notice", async (stored) => {
        const { effects } = recordingEffects();
        const r = await restoreDeckSleepSettings(stored, effects);
        expect(effects.setKeepAwake).not.toHaveBeenCalled();
        expect(r.settings).toEqual(stored);
        expect(r.notice).toBeNull();
    });
});

describe("restoreDeckSleepAtBoot", () => {
    beforeEach(() => {
        __clearPluginMocks();
        streamDeckEventLog.clear();
    });

    it("re-arms the plugin from storage, keepAwake on", async () => {
        stubStorage({ [WAKE_ON_KEY_PRESS_KEY]: "true" });
        const wake = vi.fn().mockResolvedValue({ enabled: true });
        const set = vi.fn();
        __setPluginMock("StreamDeckPlugin", {
            getPowerOptions: vi.fn().mockResolvedValue({ showOverLockScreen: true, keepAwake: true }),
            setPowerOptions: set,
            setWakeOnKeyPress: wake,
        });
        const bus = new EventBus();
        const seen: unknown[] = [];
        bus.addEventListener(Events.STREAMDECK_KEEP_AWAKE, (e: any) => seen.push(e.detail));

        await restoreDeckSleepAtBoot(bus);

        expect(wake).toHaveBeenCalledWith({ enabled: true });
        expect(set).not.toHaveBeenCalled();
        expect(seen).toEqual([{ enabled: true }]);
        expect(streamDeckEventLog.getAll()).toEqual([]);
    });

    it.each(["en", "fr"] as const)(
        "turns off a deck-lit option stored without keepAwake, journals it once (%s)",
        async (lang) => {
            const store = stubStorage({ [WAKE_ON_KEY_PRESS_KEY]: "true", app_lang: lang });
            const set = vi.fn();
            const wake = vi.fn().mockResolvedValue({ enabled: false });
            __setPluginMock("StreamDeckPlugin", {
                getPowerOptions: vi.fn().mockResolvedValue({
                    showOverLockScreen: false, keepAwake: false,
                }),
                setPowerOptions: set,
                setWakeOnKeyPress: wake,
            });
            const bus = new EventBus();
            const seen: unknown[] = [];
            bus.addEventListener(Events.STREAMDECK_KEEP_AWAKE, (e: any) => seen.push(e.detail));

            const r = await restoreDeckSleepAtBoot(bus);

            expect(set).not.toHaveBeenCalled();
            expect(wake).toHaveBeenCalledWith({ enabled: false });
            expect(store.get(WAKE_ON_KEY_PRESS_KEY)).toBe("false");
            expect(seen).toEqual([{ enabled: false }]);
            expect(r.settings).toEqual(settings(false, false));
            const lines = streamDeckEventLog.getAll().map((e) => e.text);
            expect(lines).toEqual([(lang === "en" ? en : fr)[NOTICE_WAKE_OFF_AT_BOOT]]);
        },
    );

    it("stores the deck-lit option off where the plugin is missing", async () => {
        const store = stubStorage({ [WAKE_ON_KEY_PRESS_KEY]: "true" });
        const r = await restoreDeckSleepAtBoot();
        expect(store.get(WAKE_ON_KEY_PRESS_KEY)).toBe("false");
        expect(r.settings.wakeOnKeyPress).toBe(false);
        expect(streamDeckEventLog.getAll()).toHaveLength(1);
    });

    it("journals nothing when the stored pair is coupled", async () => {
        stubStorage({ [WAKE_ON_KEY_PRESS_KEY]: "false" });
        await restoreDeckSleepAtBoot();
        expect(streamDeckEventLog.getAll()).toEqual([]);
    });
});

describe("deckSleepEffects", () => {
    beforeEach(() => {
        __clearPluginMocks();
    });

    it("stores keepAwake through setPowerOptions and announces both options", async () => {
        const set = vi.fn().mockResolvedValue({ showOverLockScreen: true, keepAwake: true });
        __setPluginMock("StreamDeckPlugin", { setPowerOptions: set });
        const bus = new EventBus();
        const seen: unknown[] = [];
        bus.addEventListener(Events.STREAMDECK_POWER_OPTIONS, (e: any) => seen.push(e.detail));

        const p = await deckSleepEffects(bus).setKeepAwake(true);

        expect(set).toHaveBeenCalledWith({ keepAwake: true });
        expect(p).toEqual({ showOverLockScreen: true, keepAwake: true });
        expect(seen).toEqual([{ showOverLockScreen: true, keepAwake: true }]);
    });

    it("stores wake-on-key-press, tells the controller and arms the plugin", async () => {
        const store = stubStorage({ [WAKE_ON_KEY_PRESS_KEY]: "true" });
        const wake = vi.fn().mockResolvedValue({ enabled: false });
        __setPluginMock("StreamDeckPlugin", { setWakeOnKeyPress: wake });
        const bus = new EventBus();
        const seen: unknown[] = [];
        bus.addEventListener(Events.STREAMDECK_KEEP_AWAKE, (e: any) => seen.push(e.detail));

        await deckSleepEffects(bus).setWakeOnKeyPress(false);

        expect(store.get(WAKE_ON_KEY_PRESS_KEY)).toBe("false");
        expect(seen).toEqual([{ enabled: false }]);
        expect(wake).toHaveBeenCalledWith({ enabled: false });
        expect(storedWakeOnKeyPress()).toBe(false);
    });

    it("stores wake-on-key-press even where the plugin is missing", async () => {
        const store = stubStorage();
        await deckSleepEffects().setWakeOnKeyPress(true);
        expect(store.get(WAKE_ON_KEY_PRESS_KEY)).toBe("true");
        expect(storedWakeOnKeyPress()).toBe(true);
    });
});
