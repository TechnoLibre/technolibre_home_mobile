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
 * Mock of registerPlugin — used by rawHttpPlugin.ts to create RawHttp.
 * Delegates post() to global.fetch so existing fetchMock stubs work unchanged.
 */
export function registerPlugin<T>(_name: string): T {
  return {
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
  } as unknown as T;
}

/** Minimal mock for CapacitorCookies — returns no cookies in tests. */
export const CapacitorCookies = {
  getCookies: async (_options?: { url?: string }): Promise<Record<string, string>> => ({}),
  setCookie: async (_options: { url: string; key: string; value: string }): Promise<void> => {},
};
