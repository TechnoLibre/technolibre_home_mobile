import { describe, it, expect, vi, afterEach } from "vitest";
import {
  COLOR_THEME_LABELS,
  DEFAULT_GRAPHIC_PREFS,
  FONT_CSS_VALUES,
  FONT_LABELS,
  FONT_SIZE_STEPS,
  FONT_SIZE_LABELS,
  applyGraphicPrefs,
} from "../models/graphicPrefs";

// ─── Constants ────────────────────────────────────────────────────────────────

describe("GraphicPrefs constants", () => {
  it("DEFAULT_GRAPHIC_PREFS has fontFamily=sans, fontSizeScale=1, colorTheme=dark", () => {
    expect(DEFAULT_GRAPHIC_PREFS.fontFamily).toBe("sans");
    expect(DEFAULT_GRAPHIC_PREFS.fontSizeScale).toBe(1);
    expect(DEFAULT_GRAPHIC_PREFS.colorTheme).toBe("dark");
  });

  it("COLOR_THEME_LABELS provides a label for dark and light", () => {
    expect(COLOR_THEME_LABELS.dark).toBeTruthy();
    expect(COLOR_THEME_LABELS.light).toBeTruthy();
  });

  it("FONT_CSS_VALUES provides CSS strings for all three font families", () => {
    expect(FONT_CSS_VALUES.sans).toContain("sans-serif");
    expect(FONT_CSS_VALUES.serif).toContain("serif");
    expect(FONT_CSS_VALUES.mono).toContain("monospace");
  });

  it("FONT_LABELS provides a label for every font family", () => {
    expect(FONT_LABELS.sans).toBeTruthy();
    expect(FONT_LABELS.serif).toBeTruthy();
    expect(FONT_LABELS.mono).toBeTruthy();
  });

  it("FONT_SIZE_STEPS has exactly 5 steps in ascending order", () => {
    expect(FONT_SIZE_STEPS).toHaveLength(5);
    for (let i = 1; i < FONT_SIZE_STEPS.length; i++) {
      expect(FONT_SIZE_STEPS[i]).toBeGreaterThan(FONT_SIZE_STEPS[i - 1]);
    }
  });

  it("FONT_SIZE_STEPS contains 1 as the middle (normal) value", () => {
    const mid = Math.floor(FONT_SIZE_STEPS.length / 2);
    expect(FONT_SIZE_STEPS[mid]).toBe(1);
  });

  it("FONT_SIZE_LABELS has the same length as FONT_SIZE_STEPS", () => {
    expect(FONT_SIZE_LABELS).toHaveLength(FONT_SIZE_STEPS.length);
  });

  it("every FONT_SIZE_LABEL is a non-empty string", () => {
    for (const label of FONT_SIZE_LABELS) {
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

// ─── applyGraphicPrefs ────────────────────────────────────────────────────────

describe("applyGraphicPrefs", () => {
  afterEach(() => vi.unstubAllGlobals());

  function makeDocStub() {
    const dataset: Record<string, string> = {};
    const setProperty = vi.fn();
    vi.stubGlobal("document", { documentElement: { style: { setProperty }, dataset } });
    return { setProperty, dataset };
  }

  it("sets --app-font-family CSS variable on documentElement", () => {
    const { setProperty } = makeDocStub();
    applyGraphicPrefs({ fontFamily: "mono", fontSizeScale: 1, colorTheme: "dark" });
    expect(setProperty).toHaveBeenCalledWith("--app-font-family", FONT_CSS_VALUES.mono);
  });

  it("sets --app-font-scale CSS variable on documentElement", () => {
    const { setProperty } = makeDocStub();
    applyGraphicPrefs({ fontFamily: "serif", fontSizeScale: 1.3, colorTheme: "dark" });
    expect(setProperty).toHaveBeenCalledWith("--app-font-scale", "1.3");
  });

  it("sets data-theme attribute on documentElement", () => {
    const { dataset } = makeDocStub();
    applyGraphicPrefs({ fontFamily: "sans", fontSizeScale: 1, colorTheme: "light" });
    expect(dataset.theme).toBe("light");
  });

  it("dark theme sets data-theme=dark", () => {
    const { dataset } = makeDocStub();
    applyGraphicPrefs({ fontFamily: "sans", fontSizeScale: 1, colorTheme: "dark" });
    expect(dataset.theme).toBe("dark");
  });

  it("applies all font families without error", () => {
    makeDocStub();
    for (const family of ["sans", "serif", "mono"] as const) {
      expect(() => applyGraphicPrefs({ fontFamily: family, fontSizeScale: 1, colorTheme: "dark" })).not.toThrow();
    }
  });

  it("applies all FONT_SIZE_STEPS without error", () => {
    makeDocStub();
    for (const scale of FONT_SIZE_STEPS) {
      expect(() => applyGraphicPrefs({ fontFamily: "sans", fontSizeScale: scale, colorTheme: "dark" })).not.toThrow();
    }
  });
});
