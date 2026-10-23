import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NetworkService } from "../services/networkService";
import { __resetNetwork, __setNetworkStatus } from "@capacitor/network";

describe("NetworkService", () => {
  beforeEach(() => __resetNetwork());
  afterEach(() => vi.unstubAllGlobals());

  it("reports the plugin's status and connection type", async () => {
    const svc = new NetworkService();
    expect(await svc.status()).toEqual({ connected: true, connectionType: "wifi" });
    __setNetworkStatus({ connected: true, connectionType: "cellular" });
    expect(await svc.status()).toEqual({ connected: true, connectionType: "cellular" });
    __setNetworkStatus({ connected: false, connectionType: "none" });
    expect(await svc.isOnline()).toBe(false);
  });

  it("counts a Wi-Fi link without validated internet as connected (server on the LAN)", async () => {
    __setNetworkStatus({ connected: false, connectionType: "wifi" });
    expect(await new NetworkService().status()).toEqual({ connected: true, connectionType: "wifi" });
  });

  it("calls back when a LAN-only Wi-Fi comes up after no link at all", async () => {
    __setNetworkStatus({ connected: false, connectionType: "none" });
    const cb = vi.fn();
    await new NetworkService().onReconnect(cb);
    __setNetworkStatus({ connected: false, connectionType: "wifi" });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("calls onWifi back when the device, online, moves onto Wi-Fi, not on a return from offline", async () => {
    __setNetworkStatus({ connected: true, connectionType: "cellular" });
    const wifi = vi.fn();
    const reconnect = vi.fn();
    const svc = new NetworkService();
    await svc.onWifi(wifi);
    await svc.onReconnect(reconnect);
    __setNetworkStatus({ connected: true, connectionType: "wifi" });
    __setNetworkStatus({ connected: true, connectionType: "wifi" });
    expect(wifi).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();
    __setNetworkStatus({ connected: false, connectionType: "none" });
    __setNetworkStatus({ connected: true, connectionType: "wifi" });
    expect(wifi).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("maps an unexpected connection type to unknown", async () => {
    __setNetworkStatus({ connected: true, connectionType: "ethernet" });
    expect((await new NetworkService().status()).connectionType).toBe("unknown");
  });

  it("counts an unvalidated unknown link (Ethernet, tethering) as connected", async () => {
    __setNetworkStatus({ connected: false, connectionType: "unknown" });
    expect(await new NetworkService().isOnline()).toBe(true);
  });

  it("falls back to navigator.onLine when the plugin is missing from the APK", async () => {
    const missing = {
      getStatus: async () => { throw new Error("Network plugin is not implemented on android"); },
      addListener: async () => { throw new Error("not implemented"); },
    };
    vi.stubGlobal("navigator", { onLine: false });
    expect(await new NetworkService(missing as any).status()).toEqual({ connected: false, connectionType: "unknown" });
  });

  it("calls back on each offline → online transition only", async () => {
    __setNetworkStatus({ connected: false, connectionType: "none" });
    const svc = new NetworkService();
    const cb = vi.fn();
    const stop = await svc.onReconnect(cb);

    __setNetworkStatus({ connected: true, connectionType: "wifi" });
    __setNetworkStatus({ connected: true, connectionType: "cellular" });
    expect(cb).toHaveBeenCalledTimes(1);
    __setNetworkStatus({ connected: false, connectionType: "none" });
    __setNetworkStatus({ connected: true, connectionType: "wifi" });
    expect(cb).toHaveBeenCalledTimes(2);

    stop();
    await Promise.resolve();
    __setNetworkStatus({ connected: false, connectionType: "none" });
    __setNetworkStatus({ connected: true, connectionType: "wifi" });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("listens to the window online event when the plugin cannot", async () => {
    const listeners: Record<string, () => void> = {};
    vi.stubGlobal("window", {
      addEventListener: (evt: string, fn: () => void) => { listeners[evt] = fn; },
      removeEventListener: vi.fn(),
    });
    const missing = {
      getStatus: async () => { throw new Error("not implemented"); },
      addListener: async () => { throw new Error("not implemented"); },
    };
    const cb = vi.fn();
    await new NetworkService(missing as any).onReconnect(cb);
    listeners.online();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
