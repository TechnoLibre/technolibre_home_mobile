import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetStats } = vi.hoisted(() => ({
    mockGetStats: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
    registerPlugin: () => ({ getStats: mockGetStats }),
}));

import { DeviceStatsPlugin, DeviceStats } from "../plugins/deviceStatsPlugin";

describe("DeviceStatsPlugin TS bridge", () => {
    beforeEach(() => {
        mockGetStats.mockReset();
    });

    it("getStats returns the typed payload from native", async () => {
        const sample: DeviceStats = {
            ramTotal: 8 * 1024 ** 3,
            ramUsed: 4 * 1024 ** 3,
            ramAvail: 4 * 1024 ** 3,
            ramPct: 50,
            cpuPct: 12,
            netRxBytesPerSec: 1024,
            netTxBytesPerSec: 256,
        };
        mockGetStats.mockResolvedValue(sample);
        const r = await DeviceStatsPlugin.getStats();
        expect(r).toEqual(sample);
        expect(mockGetStats).toHaveBeenCalledTimes(1);
    });

    it("propagates a native error rather than swallowing it", async () => {
        mockGetStats.mockRejectedValue(new Error("perms denied"));
        await expect(DeviceStatsPlugin.getStats()).rejects.toThrow(/perms denied/);
    });
});
