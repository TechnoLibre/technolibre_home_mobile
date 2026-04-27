import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";

/** A host discovered during a network scan. */
export interface ScannedHost {
    /** IPv4 address of the discovered machine. */
    host: string;
    /** Open port (always 22 for SSH). */
    port: number;
    /** SSH banner string, e.g. "SSH-2.0-OpenSSH_8.9p1". */
    banner: string;
    /** Reverse-DNS hostname, if the local network has PTR records (optional). */
    hostname?: string;
}

export interface NetworkInterfaceAddress {
    ip: string;
    family: "ipv4" | "ipv6";
    prefixLength: number;
}

export interface NetworkInterfaceInfo {
    name: string;
    displayName: string;
    up: boolean;
    loopback: boolean;
    mac: string;
    addresses: NetworkInterfaceAddress[];
}

interface NetworkScanPlugin {
    /**
     * Scan the local /24 subnet for SSH services.
     * Fires "hostFound" events for each discovered host.
     * Resolves with the full list when the scan completes.
     */
    scan(opts?: { timeoutMs?: number }): Promise<{ hosts: ScannedHost[] }>;
    /** Cancel an in-progress scan. */
    cancelScan(): Promise<void>;
    /** Enumerate every network interface on the device with its IPs. */
    listInterfaces(): Promise<{ interfaces: NetworkInterfaceInfo[] }>;
    addListener(
        event: "hostFound",
        fn: (host: ScannedHost) => void
    ): Promise<PluginListenerHandle>;
}

export const NetworkScanPlugin = registerPlugin<NetworkScanPlugin>("NetworkScanPlugin");
