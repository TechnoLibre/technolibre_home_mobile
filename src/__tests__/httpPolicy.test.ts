import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { assertUrlAllowed, InsecureHttpError, isHttpAllowed, onHttpPolicyChange, setHttpAllowed } from "../services/odoo/httpPolicy";
import { OdooRpcClient, syncSessionKey } from "../services/odoo/odooRpcClient";

/** In-memory localStorage for the node test environment. */
function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
  };
}

describe("http policy", () => {
  beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it("refuses http by default and allows https", () => {
    expect(isHttpAllowed()).toBe(false);
    expect(() => assertUrlAllowed("http://odoo.example.com")).toThrow(InsecureHttpError);
    expect(() => assertUrlAllowed("HTTP://odoo.example.com")).toThrow(InsecureHttpError);
    expect(() => assertUrlAllowed("https://odoo.example.com")).not.toThrow();
  });

  it("allows http once the option is on, and refuses it again once off", () => {
    setHttpAllowed(true);
    expect(() => assertUrlAllowed("http://odoo.example.com")).not.toThrow();
    setHttpAllowed(false);
    expect(() => assertUrlAllowed("http://odoo.example.com")).toThrow(InsecureHttpError);
  });

  it("tells its listeners each time the option is set, until they unsubscribe", () => {
    const seen: boolean[] = [];
    const stop = onHttpPolicyChange((allowed) => seen.push(allowed));
    setHttpAllowed(true);
    setHttpAllowed(false);
    stop();
    setHttpAllowed(true);
    expect(seen).toEqual([true, false]);
  });

  it("counts unreadable storage as off", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    setHttpAllowed(true);
    expect(isHttpAllowed()).toBe(false);
  });

  it("stops a request to an http server before anything is sent", async () => {
    const creds = { odooUrl: "http://odoo.example.com", username: "u", password: "p", database: "db" };
    await SecureStoragePlugin.set({
      key: syncSessionKey(creds),
      value: JSON.stringify({ sessionId: "sid", odooMajorVersion: 17, createdAt: new Date().toISOString() }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const err = await new OdooRpcClient().callKw(creds, "res.partner", "search_count", [[]]).catch((e) => e);
    expect(err).toBeInstanceOf(InsecureHttpError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
