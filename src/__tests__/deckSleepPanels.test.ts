import { describe, it, expect, vi, beforeEach } from "vitest";

// vitest.config.ts aliases @capacitor/core to src/__mocks__, whose
// registerPlugin resolves each method against __setPluginMock.
import { __setPluginMock, __clearPluginMocks } from "@capacitor/core";
import { EventBus } from "@odoo/owl";
import { Events } from "../constants/events";
import { t } from "../i18n";
import { translations as en } from "../i18n/en";
import { translations as fr } from "../i18n/fr";
import {
    ERROR_KEEP_AWAKE_NOT_STORED,
    NOTICE_KEEP_AWAKE_TURNED_ON,
    NOTICE_WAKE_TURNED_OFF,
    WAKE_ON_KEY_PRESS_KEY,
} from "../services/deckSleepCoupling";
import { OptionsKeepAwakeComponent } from "../components/options/keep_awake/options_keep_awake_component";
import { OptionsStreamDeckComponent } from "../components/options/streamdeck/options_streamdeck_component";

/** localStorage does not exist in the node environment; i18n reads it. */
function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
    const store = new Map(Object.entries({ app_lang: "en", ...initial }));
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
    });
    return store;
}

/** A plugin whose stored power options follow setPowerOptions. */
function mockPlugin(keepAwake: boolean) {
    let power = { showOverLockScreen: false, keepAwake };
    const setPowerOptions = vi.fn(async (opts: Partial<typeof power>) => {
        power = { ...power, ...opts };
        return power;
    });
    const setWakeOnKeyPress = vi.fn(async (o: { enabled: boolean }) => o);
    __setPluginMock("StreamDeckPlugin", {
        getPowerOptions: vi.fn(async () => power),
        setPowerOptions,
        setWakeOnKeyPress,
    });
    return { setPowerOptions, setWakeOnKeyPress };
}

function sleepPanel(bus?: EventBus): any {
    const c = new (OptionsKeepAwakeComponent as any)();
    if (bus) c.env = { eventBus: bus };
    return c;
}

function deckPanel(bus?: EventBus): any {
    const c = new (OptionsStreamDeckComponent as any)();
    if (bus) c.env = { eventBus: bus };
    return c;
}

describe("Options › Sleep › keep the deck lit", () => {
    beforeEach(() => {
        __clearPluginMocks();
    });

    it("turns keepAwake on with it, and says so", async () => {
        const store = stubStorage();
        const { setPowerOptions, setWakeOnKeyPress } = mockPlugin(false);
        const c = sleepPanel();

        await c.onToggleDeck({ target: { checked: true } });

        expect(setWakeOnKeyPress).toHaveBeenCalledWith({ enabled: true });
        expect(setPowerOptions).toHaveBeenCalledWith({ keepAwake: true });
        expect(store.get(WAKE_ON_KEY_PRESS_KEY)).toBe("true");
        expect(c.state.deckEnabled).toBe(true);
        expect(c.state.notice).toBe(t(NOTICE_KEEP_AWAKE_TURNED_ON));
        expect(c.state.error).toBe("");
    });

    it("leaves keepAwake alone when it is already on", async () => {
        stubStorage();
        const { setPowerOptions } = mockPlugin(true);
        const c = sleepPanel();

        await c.onToggleDeck({ target: { checked: true } });

        expect(setPowerOptions).not.toHaveBeenCalled();
        expect(c.state.notice).toBe("");
    });

    it("turns off without touching keepAwake", async () => {
        const store = stubStorage({ [WAKE_ON_KEY_PRESS_KEY]: "true" });
        const { setPowerOptions, setWakeOnKeyPress } = mockPlugin(true);
        const c = sleepPanel();
        c.state.deckEnabled = true;

        await c.onToggleDeck({ target: { checked: false } });

        expect(setWakeOnKeyPress).toHaveBeenCalledWith({ enabled: false });
        expect(setPowerOptions).not.toHaveBeenCalled();
        expect(store.get(WAKE_ON_KEY_PRESS_KEY)).toBe("false");
        expect(c.state.deckEnabled).toBe(false);
    });

    it("stays off and says why when keepAwake cannot be stored", async () => {
        const store = stubStorage();
        const setWakeOnKeyPress = vi.fn().mockResolvedValue({ enabled: true });
        __setPluginMock("StreamDeckPlugin", {
            getPowerOptions: vi.fn().mockResolvedValue({ keepAwake: false }),
            setPowerOptions: vi.fn().mockRejectedValue(new Error("refused")),
            setWakeOnKeyPress,
        });
        const c = sleepPanel();
        const box = { checked: true };

        await c.onToggleDeck({ target: box });

        expect(setWakeOnKeyPress).not.toHaveBeenCalled();
        expect(store.has(WAKE_ON_KEY_PRESS_KEY)).toBe(false);
        expect(c.state.deckEnabled).toBe(false);
        expect(box.checked).toBe(false);
        expect(c.state.notice).toBe("");
        expect(c.state.error).toContain("refused");
    });

    it("stays off and says why when the plugin stores keepAwake off", async () => {
        const store = stubStorage();
        __setPluginMock("StreamDeckPlugin", {
            getPowerOptions: vi.fn().mockResolvedValue({ keepAwake: false }),
            setPowerOptions: vi.fn().mockResolvedValue({ keepAwake: false }),
            setWakeOnKeyPress: vi.fn().mockResolvedValue({ enabled: true }),
        });
        const c = sleepPanel();
        const box = { checked: true };

        await c.onToggleDeck({ target: box });

        expect(store.has(WAKE_ON_KEY_PRESS_KEY)).toBe(false);
        expect(c.state.deckEnabled).toBe(false);
        expect(box.checked).toBe(false);
        expect(c.state.notice).toBe("");
        expect(c.state.error).toBe(t(ERROR_KEEP_AWAKE_NOT_STORED));
    });

    it("follows a change made from the Stream Deck section", () => {
        stubStorage();
        const bus = new EventBus();
        const c = sleepPanel(bus);
        c.setup();
        c.state.deckEnabled = true;

        bus.trigger(Events.STREAMDECK_KEEP_AWAKE, { enabled: false });

        expect(c.state.deckEnabled).toBe(false);
    });
});

describe("Options › Stream Deck › keepAwake", () => {
    beforeEach(() => {
        __clearPluginMocks();
    });

    it("turns the Sleep section's deck-lit option off with it, and says so", async () => {
        const store = stubStorage({ [WAKE_ON_KEY_PRESS_KEY]: "true" });
        const { setPowerOptions, setWakeOnKeyPress } = mockPlugin(true);
        const c = deckPanel();
        c.state.power = { showOverLockScreen: false, keepAwake: true };
        const box = { checked: false };

        await c.togglePowerOption("keepAwake", false, box);

        expect(setPowerOptions).toHaveBeenCalledWith({ keepAwake: false });
        expect(setWakeOnKeyPress).toHaveBeenCalledWith({ enabled: false });
        expect(store.get(WAKE_ON_KEY_PRESS_KEY)).toBe("false");
        expect(c.state.power.keepAwake).toBe(false);
        expect(box.checked).toBe(false);
        expect(c.state.powerNotice).toBe(t(NOTICE_WAKE_TURNED_OFF));
    });

    it("turns off alone when the deck-lit option is already off", async () => {
        stubStorage();
        const { setWakeOnKeyPress } = mockPlugin(true);
        const c = deckPanel();
        c.state.power = { showOverLockScreen: false, keepAwake: true };

        await c.togglePowerOption("keepAwake", false);

        expect(setWakeOnKeyPress).not.toHaveBeenCalled();
        expect(c.state.powerNotice).toBe("");
    });

    it("turns on without touching the deck-lit option", async () => {
        const store = stubStorage();
        const { setWakeOnKeyPress } = mockPlugin(false);
        const c = deckPanel();

        await c.togglePowerOption("keepAwake", true);

        expect(c.state.power.keepAwake).toBe(true);
        expect(setWakeOnKeyPress).not.toHaveBeenCalled();
        expect(store.has(WAKE_ON_KEY_PRESS_KEY)).toBe(false);
    });

    it("follows a change made from the Sleep section", () => {
        stubStorage();
        const bus = new EventBus();
        const c = deckPanel(bus);
        c.setup();

        bus.trigger(Events.STREAMDECK_POWER_OPTIONS, {
            showOverLockScreen: false, keepAwake: true,
        });

        expect(c.state.power).toEqual({ showOverLockScreen: false, keepAwake: true });
    });
});

describe("i18n — coupled deck sleep settings", () => {
    it.each([["en", en], ["fr", fr]])("%s lines name the setting that moved", (_, dict) => {
        expect(dict[NOTICE_KEEP_AWAKE_TURNED_ON]).toContain(dict["streamdeck.power_keep_awake"]);
        expect(dict[NOTICE_WAKE_TURNED_OFF]).toContain(dict["sleep.deck_awake"]);
    });

    it.each([["en", en], ["fr", fr]])("%s refusal names the option that stayed off", (_, dict) => {
        expect(dict[ERROR_KEEP_AWAKE_NOT_STORED]).toContain(dict["streamdeck.power_keep_awake"]);
        expect(dict[ERROR_KEEP_AWAKE_NOT_STORED]).toContain(dict["sleep.deck_awake"]);
    });

    it.each([["en", en], ["fr", fr]])("%s hints name the setting they move", (_, dict) => {
        expect(dict["sleep.deck_awake_hint"]).toContain(dict["streamdeck.power_keep_awake"]);
        expect(dict["streamdeck.power_keep_awake_hint"]).toContain(dict["sleep.deck_awake"]);
    });
});

describe("i18n — screen wake by a deck key press", () => {
    // A key press turns the screen on only with showOverLockScreen
    // (DeckPowerOptions.wakeScreenOnKeyPress): each hint names the other
    // option by the label its section shows.
    it.each([["en", en], ["fr", fr]])("%s Sleep hint names the lock-screen option", (_, dict) => {
        expect(dict["sleep.deck_awake_hint"]).toContain(dict["streamdeck.power_show_over_lock_screen"]);
    });

    it.each([["en", en], ["fr", fr]])("%s lock-screen hint names the Sleep option", (_, dict) => {
        expect(dict["streamdeck.power_show_over_lock_screen_hint"]).toContain(dict["sleep.deck_awake"]);
    });
});
