import { translations as fr } from "./fr";
import { translations as en } from "./en";

export type Locale = "fr" | "en";

const STORAGE_KEY = "app_lang";

export function getCurrentLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "en" ? "en" : "fr";
  } catch {
    return "fr";
  }
}

export function setLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
    window.location.reload();
  } catch {
    // non-browser environment — no-op
  }
}

const DICTS: Record<Locale, Record<string, string>> = { fr, en };

export function t(
  key: string,
  params?: Record<string, string | number>
): string {
  const locale = getCurrentLocale();
  const dict = DICTS[locale];
  let text = dict[key];
  if (text === undefined) {
    // Fallback: try French, then the raw key
    text = fr[key] ?? key;
    if (text === key) {
      console.warn(`[i18n] Missing translation: "${key}"`);
    }
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}
