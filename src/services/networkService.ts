import { Network } from "@capacitor/network";

/** Kind of link the device is on; "unknown" when no plugin answered. */
export type ConnectionType = "wifi" | "cellular" | "none" | "unknown";

export interface NetworkStatus {
  /**
   * A server may be reachable: the plugin reports a validated internet
   * link, or any link is up at all.
   */
  connected: boolean;
  connectionType: ConnectionType;
}

/** The part of @capacitor/network the service uses, replaceable in tests. */
export interface NetworkAdapter {
  getStatus(): Promise<{ connected: boolean; connectionType: string }>;
  addListener(
    event: "networkStatusChange",
    cb: (status: { connected: boolean; connectionType: string }) => void
  ): Promise<{ remove: () => Promise<void> | void }>;
}

function normalizeType(type: string | undefined): ConnectionType {
  return type === "wifi" || type === "cellular" || type === "none" ? type : "unknown";
}

/** navigator.onLine, or true where no navigator exists. */
function browserOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/**
 * Connectivity as reported by @capacitor/network: the Android
 * ConnectivityManager on device, the browser's online state on the web.
 * navigator.onLine alone is unreliable inside the Android WebView. An APK
 * built without the plugin answers "not implemented"; the service then
 * falls back to navigator.onLine and the window "online" event.
 *
 * On Android the plugin's own "connected" requires a VALIDATED link, which
 * a Wi-Fi with no internet uplink never gets although a server on that
 * network answers. So any link the plugin reports (Wi-Fi, cellular, or
 * "unknown": Ethernet, tethering) counts as connected here: only "none",
 * no link at all, means offline. Connected therefore means a
 * server MAY answer; callers still treat a failed request as a reason to
 * retry later.
 */
export class NetworkService {
  constructor(private adapter: NetworkAdapter = Network as unknown as NetworkAdapter) {}

  async status(): Promise<NetworkStatus> {
    try {
      return this.normalize(await this.adapter.getStatus());
    } catch {
      return { connected: browserOnline(), connectionType: "unknown" };
    }
  }

  private normalize(status: { connected: boolean; connectionType: string }): NetworkStatus {
    const connectionType = normalizeType(status.connectionType);
    return {
      connected: !!status.connected || connectionType !== "none",
      connectionType,
    };
  }

  async isOnline(): Promise<boolean> {
    return (await this.status()).connected;
  }

  /**
   * Calls cb each time the device goes from offline to online. Returns a
   * function that stops listening.
   */
  async onReconnect(cb: () => void): Promise<() => void> {
    let connected = (await this.status()).connected;
    try {
      const handle = await this.adapter.addListener("networkStatusChange", (status) => {
        const was = connected;
        connected = this.normalize(status).connected;
        if (!was && connected) cb();
      });
      return () => { void handle.remove(); };
    } catch {
      if (typeof window === "undefined") return () => {};
      const listener = () => cb();
      window.addEventListener("online", listener);
      return () => window.removeEventListener("online", listener);
    }
  }

  /**
   * Calls cb each time the device, online, moves onto Wi-Fi from another
   * link (files held back for Wi-Fi can go then); a return from offline is
   * onReconnect's. Returns a function that stops listening; none where the
   * plugin is missing.
   */
  async onWifi(cb: () => void): Promise<() => void> {
    let { connected, connectionType } = await this.status();
    try {
      const handle = await this.adapter.addListener("networkStatusChange", (status) => {
        const was = { connected, connectionType };
        ({ connected, connectionType } = this.normalize(status));
        if (was.connected && connected && was.connectionType !== "wifi" && connectionType === "wifi") cb();
      });
      return () => { void handle.remove(); };
    } catch {
      return () => {};
    }
  }
}

export const networkService = new NetworkService();
