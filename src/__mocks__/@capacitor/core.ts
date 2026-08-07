/**
 * Mock of @capacitor/core.
 *
 * Returns "web" as platform for all test scenarios.
 * CapacitorHttp and registerPlugin both delegate to global.fetch so tests
 * can stub fetch as before.
 */
export const Capacitor = {
  getPlatform: () => "web",
  isNativePlatform: () => false,
  convertFileSrc: (path: string) => path,
};

export const CapacitorHttp = {
  post: async (options: { url: string; headers?: Record<string, string>; data?: any }) => {
    const response = await fetch(options.url, {
      method: "POST",
      headers: options.headers,
      body: typeof options.data === "string" ? options.data : JSON.stringify(options.data),
    });
    const text = await response.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* keep as text */ }
    return { status: response.status, data, headers: {} };
  },
};

/**
 * Registry of per-plugin mock implementations, keyed by the name passed to
 * registerPlugin(). Tests populate it with __setPluginMock() so that plugins
 * other than RawHttp can be exercised — previously every plugin got the same
 * post()-only object, and any other method threw "is not a function".
 */
const pluginMocks = new Map<string, Record<string, any>>();

/** Register (or replace) the mock implementation of a native plugin. */
export function __setPluginMock(name: string, implementation: Record<string, any>): void {
  pluginMocks.set(name, implementation);
}

/** Drop every registered plugin mock. Call it between tests. */
export function __clearPluginMocks(): void {
  pluginMocks.clear();
}

/** Default RawHttp behaviour: delegate post() to global.fetch. */
const rawHttpFallback = {
  post: async (options: { url: string; headers?: Record<string, string>; body: string }) => {
    const response = await fetch(options.url, {
      method: "POST",
      headers: options.headers,
      body: options.body,
    });
    const text = await response.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* keep as string */ }
    return { status: response.status, headers: {}, data };
  },
};

/**
 * Mock of registerPlugin.
 *
 * Returns a proxy that resolves each property against the mock registered for
 * this plugin name, falling back to the RawHttp post() shim so existing
 * fetchMock-based tests keep working unchanged. An unmocked method rejects with
 * an explicit message rather than the opaque "undefined is not a function".
 */
export function registerPlugin<T>(name: string): T {
  return new Proxy({} as Record<string, any>, {
    get(target, property: string | symbol) {
      // 1. Anything assigned directly onto the singleton wins. Several existing
      //    tests do exactly that — `(NetworkScanPlugin as any).scan = vi.fn()` —
      //    so the target must be consulted before any fallback.
      if (property in target) {
        return (target as Record<string | symbol, any>)[property];
      }
      // 2. Implementation registered through __setPluginMock().
      const mock = pluginMocks.get(name);
      if (mock && typeof property === "string" && property in mock) {
        return mock[property];
      }
      // 3. RawHttp post() shim, kept for the fetchMock-based tests.
      if (typeof property === "string" && property in rawHttpFallback) {
        return (rawHttpFallback as Record<string, any>)[property];
      }
      // Never look like a thenable, or awaiting the plugin would hang.
      if (property === "then" || typeof property === "symbol") {
        return undefined;
      }
      // 4. Fail loudly rather than returning undefined, which surfaces as an
      //    opaque "is not a function" far from the cause.
      return async () => {
        throw new Error(
          `[mock] ${name}.${property}() is not mocked — assign it on the plugin or use __setPluginMock("${name}", { ${property}: … })`
        );
      };
    },
  }) as unknown as T;
}

/** Minimal mock for CapacitorCookies — returns no cookies in tests. */
export const CapacitorCookies = {
  getCookies: async (_options?: { url?: string }): Promise<Record<string, string>> => ({}),
  setCookie: async (_options: { url: string; key: string; value: string }): Promise<void> => {},
};
