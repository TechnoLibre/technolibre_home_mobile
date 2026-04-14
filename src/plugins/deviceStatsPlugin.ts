import { registerPlugin } from "@capacitor/core";

export interface DeviceStats {
    /** Total physical RAM in bytes. */
    ramTotal: number;
    /** RAM currently in use (bytes). */
    ramUsed: number;
    /** Available RAM (bytes). */
    ramAvail: number;
    /** RAM used percentage 0-100. */
    ramPct: number;
    /** CPU busy percentage 0-100 (delta since last call; 0 on first call). */
    cpuPct: number;
    /** Download speed in bytes/sec (delta since last call). */
    netRxBytesPerSec: number;
    /** Upload speed in bytes/sec (delta since last call). */
    netTxBytesPerSec: number;
}

interface DeviceStatsPluginInterface {
    getStats(): Promise<DeviceStats>;
}

export const DeviceStatsPlugin =
    registerPlugin<DeviceStatsPluginInterface>("DeviceStatsPlugin");
