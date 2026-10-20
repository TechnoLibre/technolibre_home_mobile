import { describe, it, expect, vi, beforeEach } from "vitest";

// vitest.config.ts aliases @capacitor/core to src/__mocks__, whose
// registerPlugin resolves each method against __setPluginMock.
import { __setPluginMock, __clearPluginMocks } from "@capacitor/core";
import {
    DECK_POWER_DEFAULTS,
    loadDeckPowerOptions,
    setDeckPowerOption,
} from "../services/streamDeckPowerOptions";
import { OptionsStreamDeckComponent } from "../components/options/streamdeck/options_streamdeck_component";

function component(): any {
    return new (OptionsStreamDeckComponent as any)();
}

describe("Stream Deck power options", () => {
    beforeEach(() => {
        __clearPluginMocks();
    });

    it("are both off by default", () => {
        expect(DECK_POWER_DEFAULTS).toEqual({
            showOverLockScreen: false,
            keepAwake: false,
        });
    });

    it("read as off when the plugin is missing (web preview)", async () => {
        // No mock registered: every plugin call rejects.
        expect(await loadDeckPowerOptions()).toEqual(DECK_POWER_DEFAULTS);
    });

    it("read back what the plugin stores", async () => {
        __setPluginMock("StreamDeckPlugin", {
            getPowerOptions: vi.fn().mockResolvedValue({
                showOverLockScreen: true,
                keepAwake: false,
            }),
        });
        expect(await loadDeckPowerOptions()).toEqual({
            showOverLockScreen: true,
            keepAwake: false,
        });
    });

    it("read a field the plugin leaves out as off", async () => {
        __setPluginMock("StreamDeckPlugin", {
            getPowerOptions: vi.fn().mockResolvedValue({ keepAwake: true }),
        });
        expect(await loadDeckPowerOptions()).toEqual({
            showOverLockScreen: false,
            keepAwake: true,
        });
    });

    it("send one option at a time to the plugin", async () => {
        const set = vi.fn().mockResolvedValue({
            showOverLockScreen: false,
            keepAwake: true,
        });
        __setPluginMock("StreamDeckPlugin", { setPowerOptions: set });

        const r = await setDeckPowerOption("keepAwake", true);

        expect(set).toHaveBeenCalledWith({ keepAwake: true });
        expect(r).toEqual({ showOverLockScreen: false, keepAwake: true });
    });

    it("send the lock-screen option under its own name", async () => {
        const set = vi.fn().mockResolvedValue({
            showOverLockScreen: true,
            keepAwake: false,
        });
        __setPluginMock("StreamDeckPlugin", { setPowerOptions: set });

        await setDeckPowerOption("showOverLockScreen", true);

        expect(set).toHaveBeenCalledWith({ showOverLockScreen: true });
    });
});

describe("Options › Stream Deck › power options", () => {
    beforeEach(() => {
        __clearPluginMocks();
    });

    it("start unchecked", () => {
        expect(component().state.power).toEqual({
            showOverLockScreen: false,
            keepAwake: false,
        });
    });

    it("load the stored values into the checkboxes", async () => {
        __setPluginMock("StreamDeckPlugin", {
            getPowerOptions: vi.fn().mockResolvedValue({
                showOverLockScreen: false,
                keepAwake: true,
            }),
        });
        const c = component();
        await c.loadPowerOptions();
        expect(c.state.power).toEqual({
            showOverLockScreen: false,
            keepAwake: true,
        });
    });

    it("propagate a checked box to the plugin and show what it stored", async () => {
        const set = vi.fn().mockResolvedValue({
            showOverLockScreen: true,
            keepAwake: false,
        });
        __setPluginMock("StreamDeckPlugin", { setPowerOptions: set });
        const c = component();

        await c.togglePowerOption("showOverLockScreen", true);

        expect(set).toHaveBeenCalledWith({ showOverLockScreen: true });
        expect(c.state.power.showOverLockScreen).toBe(true);
    });

    it("leave the box as it was when the plugin refuses", async () => {
        __setPluginMock("StreamDeckPlugin", {
            setPowerOptions: vi.fn().mockRejectedValue(new Error("boom")),
        });
        const c = component();
        const box = { checked: true };

        await c.togglePowerOption("keepAwake", true, box);

        expect(c.state.power.keepAwake).toBe(false);
        expect(box.checked).toBe(false);
        expect(c.state.error).toContain("boom");
    });
});
