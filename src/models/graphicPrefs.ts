import { t } from "../i18n";

export type FontFamily = "sans" | "serif" | "mono";
export type ColorTheme = "dark" | "dark-grey" | "light-warm" | "light";

export interface GraphicPrefs {
  fontFamily: FontFamily;
  fontSizeScale: number;
  colorTheme: ColorTheme;
  reduceMotion: boolean;
}

export const DEFAULT_GRAPHIC_PREFS: GraphicPrefs = {
  fontFamily: "sans",
  fontSizeScale: 1,
  colorTheme: "dark",
  reduceMotion: false,
};

export const FONT_CSS_VALUES: Record<FontFamily, string> = {
  sans:  '"VarOpenSans", system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono:  '"Courier New", Courier, monospace',
};

export const FONT_LABELS: Record<FontFamily, string> = {
  get sans()  { return t("font.sans"); },
  get serif() { return t("font.serif"); },
  get mono()  { return t("font.mono"); },
} as Record<FontFamily, string>;

export const FONT_SIZE_STEPS: number[] = [0.8, 0.9, 1, 1.15, 1.3];

export const FONT_SIZE_KEYS = [
  "font_size.very_small",
  "font_size.small",
  "font_size.normal",
  "font_size.large",
  "font_size.very_large",
] as const;

export function getFontSizeLabel(index: number): string {
  return t(FONT_SIZE_KEYS[index] ?? "font_size.normal");
}

/** @deprecated use getFontSizeLabel(index) for i18n-aware labels */
export const FONT_SIZE_LABELS: string[] = [
  "Très petit", "Petit", "Normal", "Grand", "Très grand",
];

export const COLOR_THEME_LABELS: Record<ColorTheme, string> = {
  get dark()         { return t("color_theme.dark"); },
  get "dark-grey"()  { return t("color_theme.dark_grey"); },
  get "light-warm"() { return t("color_theme.light_warm"); },
  get light()        { return t("color_theme.light"); },
} as Record<ColorTheme, string>;

export function applyGraphicPrefs(prefs: GraphicPrefs): void {
  const root = document.documentElement;
  root.style.setProperty("--app-font-family", FONT_CSS_VALUES[prefs.fontFamily]);
  root.style.setProperty("--app-font-scale", String(prefs.fontSizeScale));
  root.dataset.theme = prefs.colorTheme;
  root.dataset.reduceMotion = prefs.reduceMotion ? "true" : "false";
}
