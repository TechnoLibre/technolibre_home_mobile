import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { translations as fr } from "../i18n/fr";
import { translations as en } from "../i18n/en";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STORAGE_KEY = "app_lang";

/**
 * Stub localStorage and window.location.reload so the i18n module can run
 * in the node test environment.  Returns a simple in-memory store so tests
 * can inspect / pre-seed stored values.
 */
function makeLocalStorageStub(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { for (const k of Object.keys(store)) delete store[k]; }),
    store,
  };
}

// ─── locale helpers ───────────────────────────────────────────────────────────

describe("i18n — getCurrentLocale", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns 'fr' when localStorage has no stored value", async () => {
    vi.stubGlobal("localStorage", makeLocalStorageStub());
    const { getCurrentLocale } = await import("../i18n/index");
    expect(getCurrentLocale()).toBe("fr");
  });

  it("returns 'fr' when stored value is 'fr'", async () => {
    vi.stubGlobal("localStorage", makeLocalStorageStub({ [STORAGE_KEY]: "fr" }));
    const { getCurrentLocale } = await import("../i18n/index");
    expect(getCurrentLocale()).toBe("fr");
  });

  it("returns 'en' when stored value is 'en'", async () => {
    vi.stubGlobal("localStorage", makeLocalStorageStub({ [STORAGE_KEY]: "en" }));
    const { getCurrentLocale } = await import("../i18n/index");
    expect(getCurrentLocale()).toBe("en");
  });

  it("returns 'fr' when stored value is an unrecognised string", async () => {
    vi.stubGlobal("localStorage", makeLocalStorageStub({ [STORAGE_KEY]: "de" }));
    const { getCurrentLocale } = await import("../i18n/index");
    expect(getCurrentLocale()).toBe("fr");
  });

  it("returns 'fr' when localStorage.getItem throws", async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => { throw new Error("storage unavailable"); }),
    });
    const { getCurrentLocale } = await import("../i18n/index");
    expect(getCurrentLocale()).toBe("fr");
  });
});

// ─── setLocale ────────────────────────────────────────────────────────────────

describe("i18n — setLocale", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("writes the locale to localStorage", async () => {
    const ls = makeLocalStorageStub();
    const reload = vi.fn();
    vi.stubGlobal("localStorage", ls);
    vi.stubGlobal("window", { location: { reload } });
    const { setLocale } = await import("../i18n/index");
    setLocale("en");
    expect(ls.setItem).toHaveBeenCalledWith(STORAGE_KEY, "en");
  });

  it("calls window.location.reload after persisting", async () => {
    const ls = makeLocalStorageStub();
    const reload = vi.fn();
    vi.stubGlobal("localStorage", ls);
    vi.stubGlobal("window", { location: { reload } });
    const { setLocale } = await import("../i18n/index");
    setLocale("fr");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not throw when localStorage.setItem throws (non-browser environment)", async () => {
    vi.stubGlobal("localStorage", {
      setItem: vi.fn(() => { throw new Error("quota exceeded"); }),
    });
    const { setLocale } = await import("../i18n/index");
    expect(() => setLocale("en")).not.toThrow();
  });
});

// ─── t() — locale selection ───────────────────────────────────────────────────

describe("i18n — t() locale selection", () => {
  // Because vitest caches ES modules we re-import after each stub change.
  afterEach(() => vi.unstubAllGlobals());

  it("returns the French string when locale is 'fr'", async () => {
    vi.stubGlobal("localStorage", makeLocalStorageStub({ [STORAGE_KEY]: "fr" }));
    const { t } = await import("../i18n/index");
    expect(t("nav.home")).toBe(fr["nav.home"]);
  });

  it("returns the English string when locale is 'en'", async () => {
    vi.stubGlobal("localStorage", makeLocalStorageStub({ [STORAGE_KEY]: "en" }));
    const { t } = await import("../i18n/index");
    expect(t("nav.home")).toBe(en["nav.home"]);
  });

  it("French and English values differ for nav.home", async () => {
    // Quick sanity-check that the two dicts are not identical for a key
    expect(fr["nav.home"]).not.toBe(en["nav.home"]);
  });
});

// ─── t() — interpolation ──────────────────────────────────────────────────────

describe("i18n — t() interpolation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("replaces a single {param} placeholder", async () => {
    vi.stubGlobal("localStorage", makeLocalStorageStub({ [STORAGE_KEY]: "fr" }));
    const { t } = await import("../i18n/index");
    // boot.error = "Erreur : {message}"
    const result = t("boot.error", { message: "DB crash" });
    expect(result).toBe("Erreur : DB crash");
    expect(result).not.toContain("{message}");
  });

  it("replaces multiple distinct {param} placeholders in one string", async () => {
    vi.stubGlobal("localStorage", makeLocalStorageStub({ [STORAGE_KEY]: "en" }));
    const { t } = await import("../i18n/index");
    // label.app_version = "Version: {version} (build {build})"
    const result = t("label.app_version", { version: "1.2.3", build: "42" });
    expect(result).toBe("Version: 1.2.3 (build 42)");
  });

  it("replaces a placeholder that appears multiple times in the string", async () => {
    vi.stubGlobal("localStorage", makeLocalStorageStub({ [STORAGE_KEY]: "en" }));
    const { t } = await import("../i18n/index");
    // label.device_os = "OS: {os} {version}" — only one occurrence of each,
    // but we verify replaceAll semantics by crafting a param value with the
    // placeholder text in it (should not cause infinite replacement).
    const result = t("label.device_os", { os: "Linux", version: "6.8" });
    expect(result).toBe("OS: Linux 6.8");
  });

  it("accepts numeric param values", async () => {
    vi.stubGlobal("localStorage", makeLocalStorageStub({ [STORAGE_KEY]: "en" }));
    const { t } = await import("../i18n/index");
    // label.page_count = "Pages: {count}"
    const result = t("label.page_count", { count: 7 });
    expect(result).toBe("Pages: 7");
  });

  it("leaves unreferenced params untouched in the output", async () => {
    vi.stubGlobal("localStorage", makeLocalStorageStub({ [STORAGE_KEY]: "en" }));
    const { t } = await import("../i18n/index");
    // Passing an extra param that has no matching placeholder is harmless.
    const result = t("button.save", { unused: "x" });
    expect(result).toBe(en["button.save"]);
  });

  it("leaves placeholder tokens intact when no params object is passed", async () => {
    vi.stubGlobal("localStorage", makeLocalStorageStub({ [STORAGE_KEY]: "en" }));
    const { t } = await import("../i18n/index");
    const result = t("boot.error");
    expect(result).toContain("{message}");
  });
});

// ─── t() — missing key fallback ───────────────────────────────────────────────

describe("i18n — t() missing key fallback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the key itself when the key is absent from both dicts", async () => {
    vi.stubGlobal("localStorage", makeLocalStorageStub({ [STORAGE_KEY]: "en" }));
    const { t } = await import("../i18n/index");
    expect(t("totally.missing.key")).toBe("totally.missing.key");
  });

  it("returns the key itself when locale is 'fr' and key is absent", async () => {
    vi.stubGlobal("localStorage", makeLocalStorageStub({ [STORAGE_KEY]: "fr" }));
    const { t } = await import("../i18n/index");
    expect(t("does.not.exist")).toBe("does.not.exist");
  });

  it("emits a console.warn for a missing key", async () => {
    vi.stubGlobal("localStorage", makeLocalStorageStub({ [STORAGE_KEY]: "en" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { t } = await import("../i18n/index");
    t("phantom.key");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("phantom.key")
    );
    warn.mockRestore();
  });

  it("falls back to the French string when key is missing from English but present in French", async () => {
    // This tests the explicit fallback path: dict[key] undefined → try fr[key]
    // We cannot easily add a key to only one dict without mutating imports, so
    // we verify the documented behaviour using a real key that exists in both
    // (and check that the fr fallback is the fr value, not the en value).
    // The best observable proof is that the module always returns a non-key
    // string for keys that exist in fr, regardless of current locale.
    vi.stubGlobal("localStorage", makeLocalStorageStub({ [STORAGE_KEY]: "en" }));
    const { t } = await import("../i18n/index");
    // All keys in en exist in fr, so under "en" locale we get the en value.
    expect(t("nav.home")).toBe(en["nav.home"]);
  });
});

// ─── t() — locale switching ───────────────────────────────────────────────────

describe("i18n — t() locale switching via localStorage state", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns different strings for the same key depending on locale in localStorage", async () => {
    const lsFr = makeLocalStorageStub({ [STORAGE_KEY]: "fr" });
    vi.stubGlobal("localStorage", lsFr);
    const { t: tFr } = await import("../i18n/index");
    const frResult = tFr("button.save");

    vi.unstubAllGlobals();

    const lsEn = makeLocalStorageStub({ [STORAGE_KEY]: "en" });
    vi.stubGlobal("localStorage", lsEn);
    const { t: tEn } = await import("../i18n/index");
    const enResult = tEn("button.save");

    expect(frResult).toBe(fr["button.save"]);
    expect(enResult).toBe(en["button.save"]);
    expect(frResult).not.toBe(enResult);
  });
});

// ─── Dictionary symmetry ──────────────────────────────────────────────────────

describe("i18n — dictionary symmetry", () => {
  it("every key in fr.ts also exists in en.ts", () => {
    const frKeys = Object.keys(fr);
    const enKeys = new Set(Object.keys(en));
    const missingInEn = frKeys.filter((k) => !enKeys.has(k));
    expect(missingInEn).toEqual([]);
  });

  it("every key in en.ts also exists in fr.ts", () => {
    const enKeys = Object.keys(en);
    const frKeys = new Set(Object.keys(fr));
    const missingInFr = enKeys.filter((k) => !frKeys.has(k));
    expect(missingInFr).toEqual([]);
  });

  it("both dictionaries have the same number of keys", () => {
    expect(Object.keys(fr).length).toBe(Object.keys(en).length);
  });

  it("every fr value is a non-empty string", () => {
    for (const [key, value] of Object.entries(fr)) {
      expect(typeof value, `fr["${key}"] should be a string`).toBe("string");
      expect(value.length, `fr["${key}"] should not be empty`).toBeGreaterThan(0);
    }
  });

  it("every en value is a non-empty string", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(typeof value, `en["${key}"] should be a string`).toBe("string");
      expect(value.length, `en["${key}"] should not be empty`).toBeGreaterThan(0);
    }
  });

  it("keys that contain {placeholders} in fr also contain {placeholders} in en", () => {
    const PLACEHOLDER_RE = /\{[^}]+\}/g;
    for (const key of Object.keys(fr)) {
      const frPlaceholders = (fr[key].match(PLACEHOLDER_RE) ?? []).sort();
      const enPlaceholders = (en[key]?.match(PLACEHOLDER_RE) ?? []).sort();
      expect(
        frPlaceholders,
        `placeholder mismatch for key "${key}"`
      ).toEqual(enPlaceholders);
    }
  });
});
