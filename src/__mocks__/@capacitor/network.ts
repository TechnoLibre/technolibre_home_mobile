/**
 * Mock of @capacitor/network.
 *
 * Connected over Wi-Fi by default. Tests change the state with
 * __setNetworkStatus(), which also notifies the networkStatusChange
 * listeners, and reset it with __resetNetwork().
 */
type Status = { connected: boolean; connectionType: string };
type Listener = (status: Status) => void;

let current: Status = { connected: true, connectionType: "wifi" };
const listeners = new Set<Listener>();

export const Network = {
  getStatus: async (): Promise<Status> => ({ ...current }),
  addListener: async (_event: "networkStatusChange", cb: Listener) => {
    listeners.add(cb);
    return { remove: async () => { listeners.delete(cb); } };
  },
};

export function __setNetworkStatus(status: Status): void {
  current = { ...status };
  for (const cb of [...listeners]) cb({ ...current });
}

export function __resetNetwork(): void {
  current = { connected: true, connectionType: "wifi" };
  listeners.clear();
}
