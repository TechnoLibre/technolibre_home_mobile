/**
 * Vitest setup: a unit test never reaches a real host. The global fetch is
 * wrapped so that a request to anything but the loopback interface fails at
 * once with the URL, instead of hanging on DNS or leaking to a server. A test
 * that needs a fetch replaces it (vi.stubGlobal), which bypasses this guard;
 * one that talks to a server it started itself uses 127.0.0.1 or localhost.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const realFetch = globalThis.fetch;

if (typeof realFetch === "function") {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let host = "";
    try {
      host = new URL(raw).host.replace(/:\d+$/, "");
    } catch {
      // A relative URL has no host: left to the real fetch to refuse.
    }
    if (host && !LOOPBACK.has(host)) {
      return Promise.reject(
        new Error(`unit test attempted a real network request to ${raw}: mock fetch or the transport`),
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
}
