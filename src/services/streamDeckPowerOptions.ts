import { StreamDeckPlugin, DeckPowerOptions } from "../plugins/streamDeckPlugin";

/**
 * Both power options start off. The native plugin stores them (Android
 * SharedPreferences), because MainActivity and the plugin read them before
 * the WebView runs any JS; this module only reads and writes through it.
 */
export const DECK_POWER_DEFAULTS: Readonly<DeckPowerOptions> = Object.freeze({
    showOverLockScreen: false,
    keepAwake: false,
});

/** A field the plugin leaves out, or sends as anything but true, is off. */
function normalise(r: Partial<DeckPowerOptions> | undefined): DeckPowerOptions {
    return {
        showOverLockScreen: r?.showOverLockScreen === true,
        keepAwake: r?.keepAwake === true,
    };
}

/** The stored options; the defaults where the plugin is absent (web preview). */
export async function loadDeckPowerOptions(): Promise<DeckPowerOptions> {
    try {
        return normalise(await StreamDeckPlugin.getPowerOptions());
    } catch {
        return { ...DECK_POWER_DEFAULTS };
    }
}

/** Store one option and resolve with both as the plugin now holds them.
 *  Rejects when the plugin does, leaving the stored value unchanged. */
export async function setDeckPowerOption(
    name: keyof DeckPowerOptions,
    enabled: boolean,
): Promise<DeckPowerOptions> {
    return normalise(await StreamDeckPlugin.setPowerOptions({ [name]: enabled }));
}
