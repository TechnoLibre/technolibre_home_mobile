import { Capacitor } from "@capacitor/core";
import { MarianPlugin } from "../plugins/marianPlugin";
import type { MarianModel } from "../plugins/marianPlugin";
import { DatabaseService } from "./databaseService";

const PREF_API_TYPE          = "translation_api_type";
const PREF_LIBRE_URL         = "translation_libre_url";
const PREF_OLLAMA_URL        = "translation_ollama_url";
const PREF_OLLAMA_MODEL      = "translation_ollama_model";
const PREF_MARIAN_MODEL_FR_EN = "translation_marian_model_fr_en";
const PREF_MARIAN_MODEL_EN_FR = "translation_marian_model_en_fr";

const MYMEMORY_BASE  = "https://api.mymemory.translated.net/get";
const MYMEMORY_CHUNK = 450; // free-tier char limit per request

export type TranslationLang    = "fr" | "en";
export type TranslationApiType = "marian" | "ollama" | "libretranslate" | "mymemory";

/** Whether each backend requires internet access. */
export const TRANSLATION_REQUIRES_INTERNET: Record<TranslationApiType, boolean> = {
    marian:         false, // on-device — no internet, no server
    ollama:         false, // local server (LAN or device)
    libretranslate: false, // can be local, depends on configured URL
    mymemory:       true,  // cloud API — always needs internet
};

const LANG_NAMES: Record<TranslationLang, string> = {
    fr: "French",
    en: "English",
};

export class TranslationService {
    private readonly db: DatabaseService;

    constructor(db: DatabaseService) {
        this.db = db;
    }

    // ── Preferences ───────────────────────────────────────────────────────────

    async getApiType(): Promise<TranslationApiType> {
        const v = await this.db.getUserGraphicPref(PREF_API_TYPE).catch(() => null);
        if (v === "marian" || v === "libretranslate" || v === "mymemory" || v === "ollama") return v;
        return "ollama"; // default (existing installs keep Ollama; new installs can switch to MarianMT)
    }

    async setApiType(type: TranslationApiType): Promise<void> {
        await this.db.setUserGraphicPref(PREF_API_TYPE, type);
    }

    async getOllamaUrl(): Promise<string> {
        const v = await this.db.getUserGraphicPref(PREF_OLLAMA_URL).catch(() => null);
        return v ?? "http://localhost:11434";
    }

    async setOllamaUrl(url: string): Promise<void> {
        await this.db.setUserGraphicPref(PREF_OLLAMA_URL, url);
    }

    async getOllamaModel(): Promise<string> {
        const v = await this.db.getUserGraphicPref(PREF_OLLAMA_MODEL).catch(() => null);
        return v ?? "llama3.2";
    }

    async setOllamaModel(model: string): Promise<void> {
        await this.db.setUserGraphicPref(PREF_OLLAMA_MODEL, model);
    }

    async getLibreTranslateUrl(): Promise<string> {
        const v = await this.db.getUserGraphicPref(PREF_LIBRE_URL).catch(() => null);
        return v ?? "http://localhost:5000/translate";
    }

    async setLibreTranslateUrl(url: string): Promise<void> {
        await this.db.setUserGraphicPref(PREF_LIBRE_URL, url);
    }

    async getSelectedMarianModel(direction: "fr-en" | "en-fr"): Promise<MarianModel> {
        const pref = direction === "fr-en" ? PREF_MARIAN_MODEL_FR_EN : PREF_MARIAN_MODEL_EN_FR;
        const v = await this.db.getUserGraphicPref(pref).catch(() => null);
        const valid = direction === "fr-en"
            ? ["fr-en-tiny", "fr-en-base"]
            : ["en-fr-tiny", "en-fr-base"];
        if (v && valid.includes(v)) return v as MarianModel;
        return `${direction}-tiny` as MarianModel;
    }

    async setSelectedMarianModel(model: MarianModel): Promise<void> {
        const direction = model.startsWith("fr-en") ? "fr-en" : "en-fr";
        const pref = direction === "fr-en" ? PREF_MARIAN_MODEL_FR_EN : PREF_MARIAN_MODEL_EN_FR;
        await this.db.setUserGraphicPref(pref, model);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    async translate(
        text: string,
        source: TranslationLang,
        target: TranslationLang
    ): Promise<string> {
        if (source === target) return text;
        const trimmed = text.trim();
        if (!trimmed) return text;

        const apiType = await this.getApiType();
        switch (apiType) {
            case "marian":
                return this._callMarian(trimmed, source, target);
            case "ollama":
                return this._callOllama(trimmed, source, target);
            case "libretranslate":
                return this._callLibreTranslate(trimmed, source, target);
            case "mymemory":
                return this._callMyMemoryChunked(trimmed, source, target);
        }
    }

    // ── MarianMT (on-device — no internet, no server) ────────────────────────

    private async _callMarian(
        text: string,
        source: TranslationLang,
        target: TranslationLang
    ): Promise<string> {
        if (!Capacitor.isNativePlatform()) {
            throw new Error("MarianMT is only available on Android.");
        }
        const direction = `${source}-${target}` as "fr-en" | "en-fr";
        const model = await this.getSelectedMarianModel(direction);
        const { text: translated } = await MarianPlugin.translate({ text, model });
        if (!translated?.trim()) throw new Error("MarianMT returned an empty translation.");
        return translated;
    }

    // ── Ollama (local GPT — no internet) ──────────────────────────────────────

    private async _callOllama(
        text: string,
        source: TranslationLang,
        target: TranslationLang
    ): Promise<string> {
        const baseUrl = (await this.getOllamaUrl()).replace(/\/$/, "");
        const model   = await this.getOllamaModel();
        const srcName = LANG_NAMES[source];
        const tgtName = LANG_NAMES[target];

        const prompt =
            `You are a professional translator.\n` +
            `Translate the following text from ${srcName} to ${tgtName}.\n` +
            `Return ONLY the translated text — no explanations, no quotes, no commentary.\n\n` +
            text;

        const resp = await fetch(`${baseUrl}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, prompt, stream: false }),
        });

        if (!resp.ok) {
            throw new Error(`Ollama error: ${resp.status} ${resp.statusText}`);
        }

        const data = await resp.json();
        const result = (data.response as string | undefined)?.trim();
        if (!result) throw new Error("Ollama returned an empty response.");
        return result;
    }

    // ── LibreTranslate (local server or self-hosted — no internet if local) ───

    private async _callLibreTranslate(
        text: string,
        source: string,
        target: string
    ): Promise<string> {
        const apiUrl = await this.getLibreTranslateUrl();
        const resp = await fetch(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ q: text, source, target }),
        });
        if (!resp.ok) {
            throw new Error(
                `LibreTranslate error: ${resp.status} ${resp.statusText}`
            );
        }
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        return data.translatedText as string;
    }

    // ── MyMemory (cloud API — requires internet) ──────────────────────────────

    private async _callMyMemoryChunked(
        text: string,
        source: string,
        target: string
    ): Promise<string> {
        const chunks = this._chunkText(text, MYMEMORY_CHUNK);
        const parts: string[] = [];
        for (const chunk of chunks) {
            parts.push(await this._callMyMemory(chunk, source, target));
        }
        return parts.join(" ");
    }

    private async _callMyMemory(text: string, source: string, target: string): Promise<string> {
        const url =
            MYMEMORY_BASE +
            `?q=${encodeURIComponent(text)}&langpair=${source}|${target}`;
        const resp = await fetch(url);
        if (!resp.ok) {
            throw new Error(`MyMemory API error: ${resp.status} ${resp.statusText}`);
        }
        const data = await resp.json();
        if (data.responseStatus !== 200) {
            throw new Error(
                data.responseDetails ?? `Translation failed (${data.responseStatus})`
            );
        }
        return data.responseData.translatedText as string;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private _chunkText(text: string, max: number): string[] {
        if (text.length <= max) return [text];
        const chunks: string[] = [];
        let remaining = text;
        while (remaining.length > max) {
            let cut = max;
            for (let i = max - 1; i >= max / 2; i--) {
                if (/[.!?]\s/.test(remaining.slice(i - 1, i + 1))) {
                    cut = i + 1;
                    break;
                }
            }
            chunks.push(remaining.slice(0, cut).trim());
            remaining = remaining.slice(cut).trim();
        }
        if (remaining) chunks.push(remaining);
        return chunks;
    }
}
