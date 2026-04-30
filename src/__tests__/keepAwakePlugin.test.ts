import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSetEnabled, mockIsEnabled } = vi.hoisted(() => ({
    mockSetEnabled: vi.fn(),
    mockIsEnabled: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
    registerPlugin: () => ({
        setEnabled: mockSetEnabled,
        isEnabled: mockIsEnabled,
    }),
}));

import { KeepAwakePlugin } from "../plugins/keepAwakePlugin";

describe("KeepAwakePlugin TS bridge", () => {
    beforeEach(() => {
        mockSetEnabled.mockReset();
        mockIsEnabled.mockReset();
    });

    it("setEnabled forwards the flag and returns the new state", async () => {
        mockSetEnabled.mockResolvedValue({ enabled: true });
        const r = await KeepAwakePlugin.setEnabled({ enabled: true });
        expect(r.enabled).toBe(true);
        expect(mockSetEnabled).toHaveBeenCalledWith({ enabled: true });
    });

    it("setEnabled to false toggles the flag back off", async () => {
        mockSetEnabled.mockResolvedValue({ enabled: false });
        const r = await KeepAwakePlugin.setEnabled({ enabled: false });
        expect(r.enabled).toBe(false);
        expect(mockSetEnabled).toHaveBeenCalledWith({ enabled: false });
    });

    it("isEnabled returns the current flag", async () => {
        mockIsEnabled.mockResolvedValue({ enabled: true });
        expect((await KeepAwakePlugin.isEnabled()).enabled).toBe(true);
        mockIsEnabled.mockResolvedValue({ enabled: false });
        expect((await KeepAwakePlugin.isEnabled()).enabled).toBe(false);
    });
});
