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
  sans:  "Sans",
  serif: "Sérif",
  mono:  "Mono",
};

export const FONT_SIZE_STEPS: number[] = [0.8, 0.9, 1, 1.15, 1.3];

export const FONT_SIZE_LABELS: string[] = [
  "Très petit",
  "Petit",
  "Normal",
  "Grand",
  "Très grand",
];

export const COLOR_THEME_LABELS: Record<ColorTheme, string> = {
  dark:        "Nuit",
  "dark-grey": "Contraste",
  "light-warm": "Coloré",
  light:       "Clair",
};

export function applyGraphicPrefs(prefs: GraphicPrefs): void {
  const root = document.documentElement;
  root.style.setProperty("--app-font-family", FONT_CSS_VALUES[prefs.fontFamily]);
  root.style.setProperty("--app-font-scale", String(prefs.fontSizeScale));
  root.dataset.theme = prefs.colorTheme;
  root.dataset.reduceMotion = prefs.reduceMotion ? "true" : "false";
}
