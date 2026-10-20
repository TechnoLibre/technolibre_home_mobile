import type { EventBus } from "@odoo/owl";
import { Events } from "../constants/events";
import { StreamDeckPlugin, DeckPowerOptions } from "../plugins/streamDeckPlugin";
import { loadDeckPowerOptions, setDeckPowerOption } from "./streamDeckPowerOptions";
import { t } from "../i18n";

/**
 * Couples two settings shown in two Options sections:
 *  - wakeOnKeyPress — "keep the Stream Deck lit during sleep" (Sleep
 *    section): the controller skips the dim on hidden and the plugin
 *    arms the wake-on-key-press path;
 *  - keepAwake — the Stream Deck power option (wake lock and USB
 *    heartbeat) without which the bus may suspend with the screen off,
 *    so the deck goes dark and a press reaches nothing.
 * wakeOnKeyPress depends on keepAwake: turning it on turns keepAwake on,
 * turning keepAwake off turns it off. The other two directions change
 * one setting only. wakeOnKeyPress is never stored on while keepAwake
 * is off.
 */

/** localStorage key of wakeOnKeyPress; StreamDeckController reads it at boot. */
export const WAKE_ON_KEY_PRESS_KEY = "options.keepAwake.deckEnabled";

/** i18n key of the line telling why keepAwake was turned on. */
export const NOTICE_KEEP_AWAKE_TURNED_ON = "sleep.keep_awake_turned_on";
/** i18n key of the line telling why wakeOnKeyPress was turned off. */
export const NOTICE_WAKE_TURNED_OFF = "streamdeck.wake_turned_off";
/** i18n key of the line telling that keepAwake stayed off, and so did
 *  wakeOnKeyPress. */
export const ERROR_KEEP_AWAKE_NOT_STORED = "sleep.keep_awake_not_stored";

export interface DeckSleepSettings {
    wakeOnKeyPress: boolean;
    keepAwake: boolean;
}

export interface DeckSleepChange {
    setting: keyof DeckSleepSettings;
    enabled: boolean;
}

export interface DeckSleepPlan {
    /** Both settings once the change and its coupled change are applied. */
    next: DeckSleepSettings;
    /** The change the asked one drags along, or null when it drags none. */
    coupled: DeckSleepChange | null;
    /** i18n key of the line that says why the other setting moved, or null. */
    notice: string | null;
}

/** Pure rule: what changing one setting does to both. */
export function planDeckSleepChange(
    current: DeckSleepSettings,
    change: DeckSleepChange,
): DeckSleepPlan {
    const next = { ...current, [change.setting]: change.enabled };
    if (change.setting === "wakeOnKeyPress" && change.enabled && !current.keepAwake) {
        return {
            next: { ...next, keepAwake: true },
            coupled: { setting: "keepAwake", enabled: true },
            notice: NOTICE_KEEP_AWAKE_TURNED_ON,
        };
    }
    if (change.setting === "keepAwake" && !change.enabled && current.wakeOnKeyPress) {
        return {
            next: { ...next, wakeOnKeyPress: false },
            coupled: { setting: "wakeOnKeyPress", enabled: false },
            notice: NOTICE_WAKE_TURNED_OFF,
        };
    }
    return { next, coupled: null, notice: null };
}

/** The writes behind each setting, injected so the rule runs without a device. */
export interface DeckSleepEffects {
    /** Stores keepAwake; resolves with both power options as now stored. */
    setKeepAwake(enabled: boolean): Promise<DeckPowerOptions>;
    /** Stores wakeOnKeyPress and applies it. */
    setWakeOnKeyPress(enabled: boolean): Promise<void>;
}

export interface DeckSleepOutcome {
    /** Both settings as written. */
    settings: DeckSleepSettings;
    /** Both power options as stored, when keepAwake was written. */
    power?: DeckPowerOptions;
    /** i18n key of the line to show, set only when both writes took. */
    notice: string | null;
    /** Why the coupled write did not take, the change asked then left
     *  unwritten; null otherwise. */
    coupledError: string | null;
}

/**
 * Writes the coupled change first, then the change asked: keepAwake is
 * stored on before wakeOnKeyPress goes on, and wakeOnKeyPress is off
 * before keepAwake goes off, so no failure leaves the dependant on
 * without keepAwake. A coupled write that is refused, or that the plugin
 * stores otherwise than asked, stops there: the change asked is not
 * written and coupledError says why. A refused change asked rejects.
 */
export async function applyDeckSleepChange(
    current: DeckSleepSettings,
    change: DeckSleepChange,
    effects: DeckSleepEffects,
): Promise<DeckSleepOutcome> {
    const plan = planDeckSleepChange(current, change);
    const out: DeckSleepOutcome = {
        settings: { ...current },
        notice: null,
        coupledError: null,
    };
    if (plan.coupled) {
        try {
            await write(plan.coupled, effects, out);
        } catch (e) {
            out.coupledError = e instanceof Error ? e.message : String(e);
            return out;
        }
        if (out.settings[plan.coupled.setting] !== plan.coupled.enabled) {
            out.coupledError = t(ERROR_KEEP_AWAKE_NOT_STORED);
            return out;
        }
    }
    await write(change, effects, out);
    out.notice = plan.notice;
    return out;
}

async function write(
    change: DeckSleepChange,
    effects: DeckSleepEffects,
    out: DeckSleepOutcome,
): Promise<void> {
    if (change.setting === "keepAwake") {
        out.power = await effects.setKeepAwake(change.enabled);
        out.settings.keepAwake = out.power.keepAwake;
    } else {
        await effects.setWakeOnKeyPress(change.enabled);
        out.settings.wakeOnKeyPress = change.enabled;
    }
}

/** wakeOnKeyPress as stored; off where storage is unavailable. */
export function storedWakeOnKeyPress(): boolean {
    try {
        return localStorage.getItem(WAKE_ON_KEY_PRESS_KEY) === "true";
    } catch {
        return false;
    }
}

/**
 * Brings the stored settings back into force: the plugin's
 * wake-on-key-press is a static that starts off with every process, so
 * it is armed again as stored. wakeOnKeyPress stored on with keepAwake
 * off breaks the coupling, and is repaired the way turning it on works:
 * keepAwake goes on first, and when it stays off wakeOnKeyPress is
 * stored off. Resolves with both settings as left.
 */
export async function restoreDeckSleepSettings(
    stored: DeckSleepSettings,
    effects: DeckSleepEffects,
): Promise<DeckSleepOutcome> {
    if (!stored.wakeOnKeyPress || stored.keepAwake) {
        await effects.setWakeOnKeyPress(stored.wakeOnKeyPress);
        return { settings: { ...stored }, notice: null, coupledError: null };
    }
    const r = await applyDeckSleepChange(
        { ...stored, wakeOnKeyPress: false },
        { setting: "wakeOnKeyPress", enabled: true },
        effects,
    );
    if (r.coupledError) await effects.setWakeOnKeyPress(false);
    return r;
}

/**
 * restoreDeckSleepSettings on the stored values and the device writes,
 * run once at app start: no Options section has to be opened for the
 * settings to apply. Announces the result on `bus` like any change.
 */
export async function restoreDeckSleepAtBoot(bus?: EventBus): Promise<DeckSleepOutcome> {
    const power = await loadDeckPowerOptions();
    return restoreDeckSleepSettings(
        { wakeOnKeyPress: storedWakeOnKeyPress(), keepAwake: power.keepAwake },
        deckSleepEffects(bus),
    );
}

/**
 * Applies wakeOnKeyPress without storing it: the controller hears it on
 * STREAMDECK_KEEP_AWAKE, the plugin arms or disarms the wake path. A
 * missing plugin (web preview) is only logged, so the controller still
 * honours the setting. Never rejects.
 */
export async function applyWakeOnKeyPress(
    bus: EventBus | undefined,
    enabled: boolean,
): Promise<void> {
    bus?.trigger(Events.STREAMDECK_KEEP_AWAKE, { enabled });
    try {
        await StreamDeckPlugin.setWakeOnKeyPress({ enabled });
    } catch (e) {
        console.warn("[deck-sleep] setWakeOnKeyPress:", e);
    }
}

/**
 * The device writes. Each one announces its result on `bus`, so the
 * section that did not ask still shows the coupled state:
 * STREAMDECK_POWER_OPTIONS carries both power options,
 * STREAMDECK_KEEP_AWAKE carries wakeOnKeyPress.
 */
export function deckSleepEffects(bus?: EventBus): DeckSleepEffects {
    return {
        async setKeepAwake(enabled) {
            const power = await setDeckPowerOption("keepAwake", enabled);
            bus?.trigger(Events.STREAMDECK_POWER_OPTIONS, power);
            return power;
        },
        async setWakeOnKeyPress(enabled) {
            try {
                localStorage.setItem(WAKE_ON_KEY_PRESS_KEY, enabled ? "true" : "false");
            } catch { /* storage unavailable: applied for this run only */ }
            await applyWakeOnKeyPress(bus, enabled);
        },
    };
}
