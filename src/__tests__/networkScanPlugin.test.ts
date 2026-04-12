import { describe, it, expect, vi } from "vitest";
import { NetworkScanPlugin, ScannedHost } from "../plugins/networkScanPlugin";

// The @capacitor/core mock returns { post: ... } for registerPlugin().
// We add the missing network-scan methods onto the exported singleton to
// simulate what a real Capacitor plugin would expose at runtime.

describe("NetworkScanPlugin — plugin wrapper", () => {
    it("is exported and truthy", () => {
        expect(NetworkScanPlugin).toBeTruthy();
    });

    it("scan() returns a Promise resolving to { hosts: ScannedHost[] }", async () => {
        const hosts: ScannedHost[] = [
            { host: "192.168.1.10", port: 22, banner: "SSH-2.0-OpenSSH_8.9p1" },
        ];
        (NetworkScanPlugin as any).scan = vi.fn().mockResolvedValue({ hosts });

        const result = await NetworkScanPlugin.scan();
        expect(result).toHaveProperty("hosts");
        expect(Array.isArray(result.hosts)).toBe(true);
        expect(result.hosts[0].host).toBe("192.168.1.10");
        expect(result.hosts[0].port).toBe(22);
        expect(result.hosts[0].banner).toBe("SSH-2.0-OpenSSH_8.9p1");
    });

    it("scan() resolves with empty hosts array when no hosts found", async () => {
        (NetworkScanPlugin as any).scan = vi.fn().mockResolvedValue({ hosts: [] });
        const result = await NetworkScanPlugin.scan();
        expect(result.hosts).toEqual([]);
    });

    it("scan() forwards optional options", async () => {
        (NetworkScanPlugin as any).scan = vi.fn().mockResolvedValue({ hosts: [] });
        await NetworkScanPlugin.scan({ timeoutMs: 3000 });
        expect((NetworkScanPlugin as any).scan).toHaveBeenCalledWith({ timeoutMs: 3000 });
    });

    it("cancelScan() returns a Promise that resolves", async () => {
        (NetworkScanPlugin as any).cancelScan = vi.fn().mockResolvedValue(undefined);
        await expect(NetworkScanPlugin.cancelScan()).resolves.toBeUndefined();
        expect((NetworkScanPlugin as any).cancelScan).toHaveBeenCalledTimes(1);
    });

    it("addListener('hostFound', fn) returns a Promise with a remove() function", async () => {
        const removeHandle = { remove: vi.fn() };
        (NetworkScanPlugin as any).addListener = vi.fn().mockResolvedValue(removeHandle);

        const handle = await NetworkScanPlugin.addListener("hostFound", () => {});
        expect(handle).toHaveProperty("remove");
        expect(typeof handle.remove).toBe("function");
    });

    it("addListener callback accepts a ScannedHost with optional hostname", async () => {
        const captured: ScannedHost[] = [];
        (NetworkScanPlugin as any).addListener = vi.fn().mockImplementation(
            (_event: string, fn: (host: ScannedHost) => void) => {
                const withHostname: ScannedHost = {
                    host: "192.168.1.20",
                    port: 22,
                    banner: "SSH-2.0-OpenSSH_9.0",
                    hostname: "myserver.local",
                };
                const withoutHostname: ScannedHost = {
                    host: "192.168.1.21",
                    port: 22,
                    banner: "SSH-2.0-OpenSSH_8.0",
                };
                fn(withHostname);
                fn(withoutHostname);
                return Promise.resolve({ remove: () => {} });
            }
        );

        await NetworkScanPlugin.addListener("hostFound", (h) => captured.push(h));

        expect(captured).toHaveLength(2);
        expect(captured[0].hostname).toBe("myserver.local");
        expect(captured[1].hostname).toBeUndefined();
    });
});
