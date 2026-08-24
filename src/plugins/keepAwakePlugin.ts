import { registerPlugin } from "@capacitor/core";

interface KeepAwakePluginApi {
    /** Toggle FLAG_KEEP_SCREEN_ON on the main activity. While enabled,
     *  the phone screen stays on indefinitely — useful when the phone
     *  is driving a Stream Deck and we don't want the screen timeout
     *  to dim the deck LCDs. */
    setEnabled(opts: { enabled: boolean }): Promise<{ enabled: boolean }>;
    isEnabled(): Promise<{ enabled: boolean }>;
}

export const KeepAwakePlugin =
    registerPlugin<KeepAwakePluginApi>("KeepAwakePlugin");
