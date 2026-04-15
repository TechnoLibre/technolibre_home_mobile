import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { TranslationService } from "../services/translationService";
import { DatabaseService } from "../services/databaseService";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import type { MarianModel } from "../plugins/marianPlugin";

// vi.mock is hoisted to the top of the file, so the factory must not reference
// const/let declared below it. Use vi.fn() inline; grab refs via vi.mocked() later.
vi.mock("../plugins/marianPlugin", () => ({
    MarianPlugin: {
        isModelDownloaded: vi.fn().mockResolvedValue({ exists: false }),
        downloadModel:     vi.fn().mockResolvedValue(undefined),
        translate:         vi.fn().mockResolvedValue({ text: "translated text" }),
        deleteModel:       vi.fn().mockResolvedValue(undefined),
        cancelDownload:    vi.fn().mockResolvedValue(undefined),
        addListener:       vi.fn().mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) }),
    },
}));

// Re-import the mocked module to access individual spies.
import { MarianPlugin } from "../plugins/marianPlugin";

// Grab the mutable Capacitor mock so individual tests can override isNativePlatform.
import { Capacitor } from "@capacitor/core";

describe("TranslationService", () => {
    let db: DatabaseService;
    let service: TranslationService;

    beforeEach(async () => {
        vi.clearAllMocks();
        // Restore global.fetch after each test that replaces it.
        vi.restoreAllMocks();

        // Restore isNativePlatform to false (web) by default.
        (Capacitor as { isNativePlatform: () => boolean }).isNativePlatform = () => false;

        SecureStoragePlugin._store.clear();
        db = new DatabaseService();
        await db.initialize();
        service = new TranslationService(db);

        // Re-apply default mock return values cleared by vi.clearAllMocks().
        vi.mocked(MarianPlugin.translate).mockResolvedValue({ text: "translated text" });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ── getApiType ────────────────────────────────────────────────────────────

    describe("getApiType", () => {
        it("returns 'ollama' by default when no pref is stored", async () => {
            expect(await service.getApiType()).toBe("ollama");
        });

        it("returns 'marian' when stored as 'marian'", async () => {
            await db.setUserGraphicPref("translation_api_type", "marian");
            expect(await service.getApiType()).toBe("marian");
        });

        it("returns 'libretranslate' when stored as 'libretranslate'", async () => {
            await db.setUserGraphicPref("translation_api_type", "libretranslate");
            expect(await service.getApiType()).toBe("libretranslate");
        });

        it("returns 'mymemory' when stored as 'mymemory'", async () => {
            await db.setUserGraphicPref("translation_api_type", "mymemory");
            expect(await service.getApiType()).toBe("mymemory");
        });

        it("returns 'ollama' when stored as 'ollama'", async () => {
            await db.setUserGraphicPref("translation_api_type", "ollama");
            expect(await service.getApiType()).toBe("ollama");
        });

        it("falls back to 'ollama' when an unknown value is stored", async () => {
            await db.setUserGraphicPref("translation_api_type", "deepl_unknown");
            expect(await service.getApiType()).toBe("ollama");
        });

        it("falls back to 'ollama' when an empty string is stored", async () => {
            await db.setUserGraphicPref("translation_api_type", "");
            expect(await service.getApiType()).toBe("ollama");
        });
    });

    // ── setApiType / getApiType round-trip ────────────────────────────────────

    describe("setApiType", () => {
        it("persists 'marian' and reads it back", async () => {
            await service.setApiType("marian");
            expect(await service.getApiType()).toBe("marian");
        });

        it("persists 'libretranslate' and reads it back", async () => {
            await service.setApiType("libretranslate");
            expect(await service.getApiType()).toBe("libretranslate");
        });

        it("persists 'mymemory' and reads it back", async () => {
            await service.setApiType("mymemory");
            expect(await service.getApiType()).toBe("mymemory");
        });

        it("overwrites a previously stored value", async () => {
            await service.setApiType("marian");
            await service.setApiType("mymemory");
            expect(await service.getApiType()).toBe("mymemory");
        });
    });

    // ── getOllamaUrl / setOllamaUrl round-trip ────────────────────────────────

    describe("getOllamaUrl / setOllamaUrl", () => {
        it("returns 'http://localhost:11434' by default", async () => {
            expect(await service.getOllamaUrl()).toBe("http://localhost:11434");
        });

        it("persists a custom URL and reads it back", async () => {
            await service.setOllamaUrl("http://192.168.1.10:11434");
            expect(await service.getOllamaUrl()).toBe("http://192.168.1.10:11434");
        });

        it("overwrites a previously stored URL", async () => {
            await service.setOllamaUrl("http://first.example.com");
            await service.setOllamaUrl("http://second.example.com");
            expect(await service.getOllamaUrl()).toBe("http://second.example.com");
        });
    });

    // ── getOllamaModel / setOllamaModel round-trip ────────────────────────────

    describe("getOllamaModel / setOllamaModel", () => {
        it("returns 'llama3.2' by default", async () => {
            expect(await service.getOllamaModel()).toBe("llama3.2");
        });

        it("persists a custom model and reads it back", async () => {
            await service.setOllamaModel("mistral");
            expect(await service.getOllamaModel()).toBe("mistral");
        });

        it("overwrites a previously stored model", async () => {
            await service.setOllamaModel("mistral");
            await service.setOllamaModel("gemma3");
            expect(await service.getOllamaModel()).toBe("gemma3");
        });
    });

    // ── getLibreTranslateUrl / setLibreTranslateUrl round-trip ───────────────

    describe("getLibreTranslateUrl / setLibreTranslateUrl", () => {
        it("returns 'http://localhost:5000/translate' by default", async () => {
            expect(await service.getLibreTranslateUrl()).toBe("http://localhost:5000/translate");
        });

        it("persists a custom URL and reads it back", async () => {
            await service.setLibreTranslateUrl("http://translate.local:5000/translate");
            expect(await service.getLibreTranslateUrl()).toBe("http://translate.local:5000/translate");
        });

        it("overwrites a previously stored URL", async () => {
            await service.setLibreTranslateUrl("http://first.local/translate");
            await service.setLibreTranslateUrl("http://second.local/translate");
            expect(await service.getLibreTranslateUrl()).toBe("http://second.local/translate");
        });
    });

    // ── getSelectedMarianModel ────────────────────────────────────────────────

    describe("getSelectedMarianModel", () => {
        it("returns 'fr-en-tiny' by default for direction fr-en", async () => {
            expect(await service.getSelectedMarianModel("fr-en")).toBe("fr-en-tiny");
        });

        it("returns 'en-fr-tiny' by default for direction en-fr", async () => {
            expect(await service.getSelectedMarianModel("en-fr")).toBe("en-fr-tiny");
        });

        it("accepts 'fr-en-base' as a valid value for fr-en", async () => {
            await db.setUserGraphicPref("translation_marian_model_fr_en", "fr-en-base");
            expect(await service.getSelectedMarianModel("fr-en")).toBe("fr-en-base");
        });

        it("accepts 'fr-en-tiny' as a valid value for fr-en", async () => {
            await db.setUserGraphicPref("translation_marian_model_fr_en", "fr-en-tiny");
            expect(await service.getSelectedMarianModel("fr-en")).toBe("fr-en-tiny");
        });

        it("accepts 'en-fr-base' as a valid value for en-fr", async () => {
            await db.setUserGraphicPref("translation_marian_model_en_fr", "en-fr-base");
            expect(await service.getSelectedMarianModel("en-fr")).toBe("en-fr-base");
        });

        it("accepts 'en-fr-tiny' as a valid value for en-fr", async () => {
            await db.setUserGraphicPref("translation_marian_model_en_fr", "en-fr-tiny");
            expect(await service.getSelectedMarianModel("en-fr")).toBe("en-fr-tiny");
        });

        it("falls back to 'fr-en-tiny' when an invalid value is stored for fr-en", async () => {
            await db.setUserGraphicPref("translation_marian_model_fr_en", "fr-en-ultra");
            expect(await service.getSelectedMarianModel("fr-en")).toBe("fr-en-tiny");
        });

        it("falls back to 'en-fr-tiny' when an invalid value is stored for en-fr", async () => {
            await db.setUserGraphicPref("translation_marian_model_en_fr", "en-fr-ultra");
            expect(await service.getSelectedMarianModel("en-fr")).toBe("en-fr-tiny");
        });

        it("falls back to tiny when a cross-direction model is stored for fr-en", async () => {
            // en-fr-base is valid for en-fr but NOT for fr-en
            await db.setUserGraphicPref("translation_marian_model_fr_en", "en-fr-base");
            expect(await service.getSelectedMarianModel("fr-en")).toBe("fr-en-tiny");
        });

        it("falls back to tiny when a cross-direction model is stored for en-fr", async () => {
            // fr-en-base is valid for fr-en but NOT for en-fr
            await db.setUserGraphicPref("translation_marian_model_en_fr", "fr-en-base");
            expect(await service.getSelectedMarianModel("en-fr")).toBe("en-fr-tiny");
        });
    });

    // ── setSelectedMarianModel ────────────────────────────────────────────────

    describe("setSelectedMarianModel", () => {
        it("stores 'fr-en-tiny' in the fr-en pref key", async () => {
            await service.setSelectedMarianModel("fr-en-tiny");
            expect(await service.getSelectedMarianModel("fr-en")).toBe("fr-en-tiny");
        });

        it("stores 'fr-en-base' in the fr-en pref key", async () => {
            await service.setSelectedMarianModel("fr-en-base");
            expect(await service.getSelectedMarianModel("fr-en")).toBe("fr-en-base");
        });

        it("stores 'en-fr-tiny' in the en-fr pref key", async () => {
            await service.setSelectedMarianModel("en-fr-tiny");
            expect(await service.getSelectedMarianModel("en-fr")).toBe("en-fr-tiny");
        });

        it("stores 'en-fr-base' in the en-fr pref key", async () => {
            await service.setSelectedMarianModel("en-fr-base");
            expect(await service.getSelectedMarianModel("en-fr")).toBe("en-fr-base");
        });

        it("does not overwrite the en-fr pref when setting a fr-en model", async () => {
            await db.setUserGraphicPref("translation_marian_model_en_fr", "en-fr-base");
            await service.setSelectedMarianModel("fr-en-base");
            expect(await service.getSelectedMarianModel("en-fr")).toBe("en-fr-base");
        });

        it("does not overwrite the fr-en pref when setting an en-fr model", async () => {
            await db.setUserGraphicPref("translation_marian_model_fr_en", "fr-en-base");
            await service.setSelectedMarianModel("en-fr-base");
            expect(await service.getSelectedMarianModel("fr-en")).toBe("fr-en-base");
        });

        it("overwrites a previously stored fr-en model", async () => {
            await service.setSelectedMarianModel("fr-en-tiny");
            await service.setSelectedMarianModel("fr-en-base");
            expect(await service.getSelectedMarianModel("fr-en")).toBe("fr-en-base");
        });
    });

    // ── translate — same source/target ───────────────────────────────────────

    describe("translate — source === target", () => {
        it("returns input unchanged when source and target are both 'fr'", async () => {
            const input = "Bonjour le monde";
            expect(await service.translate(input, "fr", "fr")).toBe(input);
        });

        it("returns input unchanged when source and target are both 'en'", async () => {
            const input = "Hello world";
            expect(await service.translate(input, "en", "en")).toBe(input);
        });

        it("does not call fetch when source === target", async () => {
            const fetchSpy = vi.spyOn(global, "fetch");
            await service.translate("test", "fr", "fr");
            expect(fetchSpy).not.toHaveBeenCalled();
        });
    });

    // ── translate — empty / whitespace ────────────────────────────────────────

    describe("translate — empty and whitespace input", () => {
        it("returns empty string unchanged (source !== target)", async () => {
            expect(await service.translate("", "fr", "en")).toBe("");
        });

        it("returns whitespace-only string unchanged (source !== target)", async () => {
            const input = "   ";
            expect(await service.translate(input, "fr", "en")).toBe(input);
        });

        it("does not call fetch for empty input", async () => {
            const fetchSpy = vi.spyOn(global, "fetch");
            await service.translate("", "fr", "en");
            expect(fetchSpy).not.toHaveBeenCalled();
        });
    });

    // ── translate — backend dispatch ──────────────────────────────────────────

    describe("translate — dispatch to correct backend", () => {
        it("calls _callOllama (fetch to /api/generate) when apiType is 'ollama'", async () => {
            await service.setApiType("ollama");
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ response: "Hello world" }),
            } as Response);

            await service.translate("Bonjour", "fr", "en");

            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining("/api/generate"),
                expect.any(Object)
            );
        });

        it("calls _callLibreTranslate (fetch to libre URL) when apiType is 'libretranslate'", async () => {
            await service.setApiType("libretranslate");
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ translatedText: "Hello world" }),
            } as Response);

            await service.translate("Bonjour", "fr", "en");

            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining("localhost:5000"),
                expect.any(Object)
            );
        });

        it("calls _callMyMemoryChunked (fetch to mymemory) when apiType is 'mymemory'", async () => {
            await service.setApiType("mymemory");
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    responseStatus: 200,
                    responseData: { translatedText: "Hello world" },
                }),
            } as Response);

            await service.translate("Bonjour", "fr", "en");

            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining("mymemory.translated.net")
            );
        });

        it("calls MarianPlugin.translate when apiType is 'marian' on native platform", async () => {
            (Capacitor as { isNativePlatform: () => boolean }).isNativePlatform = () => true;
            await service.setApiType("marian");
            await db.setUserGraphicPref("translation_marian_model_fr_en", "fr-en-tiny");

            await service.translate("Bonjour", "fr", "en");

            expect(MarianPlugin.translate).toHaveBeenCalledWith(
                expect.objectContaining({ text: "Bonjour", model: "fr-en-tiny" })
            );
        });
    });

    // ── _callOllama ───────────────────────────────────────────────────────────

    describe("_callOllama (via translate with apiType=ollama)", () => {
        beforeEach(async () => {
            await service.setApiType("ollama");
        });

        it("returns the translated text from data.response", async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ response: "Hello world" }),
            } as Response);

            const result = await service.translate("Bonjour le monde", "fr", "en");
            expect(result).toBe("Hello world");
        });

        it("trims whitespace from data.response", async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ response: "  Hello world  " }),
            } as Response);

            const result = await service.translate("Bonjour", "fr", "en");
            expect(result).toBe("Hello world");
        });

        it("sends a POST request to {ollamaUrl}/api/generate", async () => {
            await service.setOllamaUrl("http://my-ollama:11434");
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ response: "Hello" }),
            } as Response);

            await service.translate("Bonjour", "fr", "en");

            expect(global.fetch).toHaveBeenCalledWith(
                "http://my-ollama:11434/api/generate",
                expect.objectContaining({ method: "POST" })
            );
        });

        it("strips a trailing slash from ollamaUrl before appending /api/generate", async () => {
            await service.setOllamaUrl("http://my-ollama:11434/");
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ response: "Hello" }),
            } as Response);

            await service.translate("Bonjour", "fr", "en");

            expect(global.fetch).toHaveBeenCalledWith(
                "http://my-ollama:11434/api/generate",
                expect.any(Object)
            );
        });

        it("includes the source language name in the prompt body", async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ response: "Hello" }),
            } as Response);

            await service.translate("Bonjour", "fr", "en");

            const body = JSON.parse(
                (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body
            );
            expect(body.prompt).toContain("French");
        });

        it("includes the target language name in the prompt body", async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ response: "Bonjour" }),
            } as Response);

            await service.translate("Hello", "en", "fr");

            const body = JSON.parse(
                (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body
            );
            expect(body.prompt).toContain("French");
        });

        it("includes the input text verbatim in the prompt body", async () => {
            const input = "Voici un texte à traduire.";
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ response: "Here is a text to translate." }),
            } as Response);

            await service.translate(input, "fr", "en");

            const body = JSON.parse(
                (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body
            );
            expect(body.prompt).toContain(input);
        });

        it("sends stream: false in the request body", async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ response: "Hello" }),
            } as Response);

            await service.translate("Bonjour", "fr", "en");

            const body = JSON.parse(
                (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body
            );
            expect(body.stream).toBe(false);
        });

        it("throws when the response is not ok (status 500)", async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 500,
                statusText: "Internal Server Error",
                json: async () => ({}),
            } as Response);

            await expect(service.translate("Bonjour", "fr", "en")).rejects.toThrow(
                "Ollama error: 500 Internal Server Error"
            );
        });

        it("throws when the response is not ok (status 404)", async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 404,
                statusText: "Not Found",
                json: async () => ({}),
            } as Response);

            await expect(service.translate("Bonjour", "fr", "en")).rejects.toThrow(
                "Ollama error: 404 Not Found"
            );
        });

        it("throws when data.response is empty", async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ response: "" }),
            } as Response);

            await expect(service.translate("Bonjour", "fr", "en")).rejects.toThrow(
                "Ollama returned an empty response."
            );
        });

        it("throws when data.response is whitespace only", async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ response: "   " }),
            } as Response);

            await expect(service.translate("Bonjour", "fr", "en")).rejects.toThrow(
                "Ollama returned an empty response."
            );
        });

        it("throws when data.response is undefined", async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({}),
            } as Response);

            await expect(service.translate("Bonjour", "fr", "en")).rejects.toThrow(
                "Ollama returned an empty response."
            );
        });
    });

    // ── _callLibreTranslate ───────────────────────────────────────────────────

    describe("_callLibreTranslate (via translate with apiType=libretranslate)", () => {
        beforeEach(async () => {
            await service.setApiType("libretranslate");
        });

        it("returns data.translatedText on success", async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ translatedText: "Hello world" }),
            } as Response);

            const result = await service.translate("Bonjour le monde", "fr", "en");
            expect(result).toBe("Hello world");
        });

        it("sends a POST request to the configured LibreTranslate URL", async () => {
            await service.setLibreTranslateUrl("http://libre.local:5000/translate");
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ translatedText: "Hello" }),
            } as Response);

            await service.translate("Bonjour", "fr", "en");

            expect(global.fetch).toHaveBeenCalledWith(
                "http://libre.local:5000/translate",
                expect.objectContaining({ method: "POST" })
            );
        });

        it("sends q, source, and target in the request body", async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ translatedText: "Hello" }),
            } as Response);

            await service.translate("Bonjour", "fr", "en");

            const body = JSON.parse(
                (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body
            );
            expect(body).toEqual(expect.objectContaining({ q: "Bonjour", source: "fr", target: "en" }));
        });

        it("throws when the response status is not ok (503)", async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 503,
                statusText: "Service Unavailable",
                json: async () => ({}),
            } as Response);

            await expect(service.translate("Bonjour", "fr", "en")).rejects.toThrow(
                "LibreTranslate error: 503 Service Unavailable"
            );
        });

        it("throws when data.error is present (even if status is ok)", async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ error: "Language pair not supported" }),
            } as Response);

            await expect(service.translate("Bonjour", "fr", "en")).rejects.toThrow(
                "Language pair not supported"
            );
        });

        it("propagates the exact error string from data.error", async () => {
            const errorMsg = "Source language 'xx' is not supported";
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ error: errorMsg }),
            } as Response);

            await expect(service.translate("Bonjour", "fr", "en")).rejects.toThrow(errorMsg);
        });
    });

    // ── _callMyMemory ─────────────────────────────────────────────────────────

    describe("_callMyMemory (via translate with apiType=mymemory, short text)", () => {
        beforeEach(async () => {
            await service.setApiType("mymemory");
        });

        it("returns responseData.translatedText on success (responseStatus=200)", async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    responseStatus: 200,
                    responseData: { translatedText: "Hello world" },
                }),
            } as Response);

            const result = await service.translate("Bonjour le monde", "fr", "en");
            expect(result).toBe("Hello world");
        });

        it("sends a GET request to the MyMemory API endpoint", async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    responseStatus: 200,
                    responseData: { translatedText: "Hello" },
                }),
            } as Response);

            await service.translate("Bonjour", "fr", "en");

            const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
            expect(calledUrl).toContain("mymemory.translated.net");
        });

        it("encodes the query parameter in the URL", async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    responseStatus: 200,
                    responseData: { translatedText: "How are you?" },
                }),
            } as Response);

            await service.translate("Comment allez-vous ?", "fr", "en");

            const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
            expect(calledUrl).toContain(encodeURIComponent("Comment allez-vous ?"));
        });

        it("includes the language pair in the URL", async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    responseStatus: 200,
                    responseData: { translatedText: "Hello" },
                }),
            } as Response);

            await service.translate("Bonjour", "fr", "en");

            const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
            expect(calledUrl).toContain("langpair=fr|en");
        });

        it("throws when the HTTP response is not ok (502)", async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 502,
                statusText: "Bad Gateway",
                json: async () => ({}),
            } as Response);

            await expect(service.translate("Bonjour", "fr", "en")).rejects.toThrow(
                "MyMemory API error: 502 Bad Gateway"
            );
        });

        it("throws when responseStatus is not 200 (e.g. 429 rate limit)", async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    responseStatus: 429,
                    responseDetails: "QUERY LIMIT EXCEEDED",
                    responseData: { translatedText: "" },
                }),
            } as Response);

            await expect(service.translate("Bonjour", "fr", "en")).rejects.toThrow(
                "QUERY LIMIT EXCEEDED"
            );
        });

        it("throws a fallback message when responseStatus !== 200 and responseDetails is absent", async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    responseStatus: 403,
                    responseData: { translatedText: "" },
                }),
            } as Response);

            await expect(service.translate("Bonjour", "fr", "en")).rejects.toThrow(
                "Translation failed (403)"
            );
        });
    });

    // ── _callMyMemoryChunked ──────────────────────────────────────────────────

    describe("_callMyMemoryChunked (via translate with apiType=mymemory)", () => {
        beforeEach(async () => {
            await service.setApiType("mymemory");
        });

        it("makes exactly 1 fetch call when text length is within the 450-char limit", async () => {
            const shortText = "a".repeat(449);
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    responseStatus: 200,
                    responseData: { translatedText: "translated" },
                }),
            } as Response);

            await service.translate(shortText, "fr", "en");
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });

        it("makes exactly 1 fetch call when text length equals exactly 450 chars", async () => {
            const exactText = "a".repeat(450);
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    responseStatus: 200,
                    responseData: { translatedText: "translated" },
                }),
            } as Response);

            await service.translate(exactText, "fr", "en");
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });

        it("makes multiple fetch calls when text exceeds 450 chars", async () => {
            const longText = "a".repeat(451);
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    responseStatus: 200,
                    responseData: { translatedText: "chunk" },
                }),
            } as Response);

            await service.translate(longText, "fr", "en");
            expect(global.fetch).toHaveBeenCalledTimes(2);
        });

        it("joins translated chunks with a single space", async () => {
            // Build text long enough to produce 3 chunks (> 900 chars)
            const part1 = "a".repeat(450);
            const part2 = "b".repeat(450);
            const part3 = "c".repeat(10);
            const longText = part1 + part2 + part3;

            let callCount = 0;
            global.fetch = vi.fn().mockImplementation(async () => {
                callCount++;
                return {
                    ok: true,
                    json: async () => ({
                        responseStatus: 200,
                        responseData: { translatedText: `part${callCount}` },
                    }),
                } as Response;
            });

            const result = await service.translate(longText, "fr", "en");
            expect(result).toBe("part1 part2 part3");
        });

        it("propagates an error from any chunk call", async () => {
            const longText = "a".repeat(451);
            let callCount = 0;
            global.fetch = vi.fn().mockImplementation(async () => {
                callCount++;
                if (callCount === 2) {
                    return {
                        ok: true,
                        json: async () => ({
                            responseStatus: 429,
                            responseDetails: "RATE LIMIT",
                            responseData: { translatedText: "" },
                        }),
                    } as Response;
                }
                return {
                    ok: true,
                    json: async () => ({
                        responseStatus: 200,
                        responseData: { translatedText: "chunk" },
                    }),
                } as Response;
            });

            await expect(service.translate(longText, "fr", "en")).rejects.toThrow("RATE LIMIT");
        });
    });

    // ── _chunkText ────────────────────────────────────────────────────────────

    describe("_chunkText (via _callMyMemoryChunked behaviour)", () => {
        // _chunkText is private; we exercise it through translate() with mymemory
        // so we can observe how many fetch calls are made and what text is sent.

        beforeEach(async () => {
            await service.setApiType("mymemory");
        });

        it("returns the original text as a single chunk when length <= max", async () => {
            const text = "Hello world.";
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    responseStatus: 200,
                    responseData: { translatedText: "Bonjour le monde." },
                }),
            } as Response);

            await service.translate(text, "en", "fr");
            expect(global.fetch).toHaveBeenCalledTimes(1);
            const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
            expect(calledUrl).toContain(encodeURIComponent("Hello world."));
        });

        it("splits at a sentence boundary ('. ') when possible", async () => {
            // Construct text > 450 chars where a '. ' exists within the last half
            const sentence1 = "a".repeat(400) + ". ";
            const sentence2 = "b".repeat(100);
            const text = sentence1 + sentence2;  // total 502 chars

            const capturedUrls: string[] = [];
            global.fetch = vi.fn().mockImplementation(async (url: string) => {
                capturedUrls.push(url);
                return {
                    ok: true,
                    json: async () => ({
                        responseStatus: 200,
                        responseData: { translatedText: "x" },
                    }),
                } as Response;
            });

            await service.translate(text, "fr", "en");

            // Should have split into 2 chunks, not done a hard cut mid-word
            expect(global.fetch).toHaveBeenCalledTimes(2);
            // First chunk ends after the period: "aaa...aaa." (trimmed)
            const firstChunkDecoded = decodeURIComponent(
                capturedUrls[0].match(/q=([^&]+)/)?.[1] ?? ""
            );
            expect(firstChunkDecoded).toMatch(/\.$/);
        });

        it("falls back to a hard cut when no sentence boundary is found", async () => {
            // 500 consecutive 'x' chars — no sentence boundary
            const text = "x".repeat(500);

            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    responseStatus: 200,
                    responseData: { translatedText: "y" },
                }),
            } as Response);

            await service.translate(text, "fr", "en");

            // Falls back to hard cut at max (450)
            expect(global.fetch).toHaveBeenCalledTimes(2);
            const firstChunkDecoded = decodeURIComponent(
                ((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string)
                    .match(/q=([^&]+)/)?.[1] ?? ""
            );
            expect(firstChunkDecoded).toHaveLength(450);
        });

        it("produces exactly 4 chunks for a 1400-char input with no boundaries", async () => {
            const text = "z".repeat(1400);

            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    responseStatus: 200,
                    responseData: { translatedText: "q" },
                }),
            } as Response);

            await service.translate(text, "fr", "en");
            // 1400 chars, hard-cut at 450 each: 450 + 450 + 450 + 50 = 4 chunks
            expect(global.fetch).toHaveBeenCalledTimes(4);
        });
    });

    // ── _callMarian ───────────────────────────────────────────────────────────

    describe("_callMarian (via translate with apiType=marian)", () => {
        beforeEach(async () => {
            await service.setApiType("marian");
        });

        it("throws 'MarianMT is only available on Android.' when not on native platform", async () => {
            (Capacitor as { isNativePlatform: () => boolean }).isNativePlatform = () => false;

            await expect(service.translate("Bonjour", "fr", "en")).rejects.toThrow(
                "MarianMT is only available on Android."
            );
        });

        it("does not call MarianPlugin.translate on web platform", async () => {
            (Capacitor as { isNativePlatform: () => boolean }).isNativePlatform = () => false;

            await expect(service.translate("Bonjour", "fr", "en")).rejects.toThrow();
            expect(MarianPlugin.translate).not.toHaveBeenCalled();
        });

        it("calls MarianPlugin.translate with the correct model and text on native", async () => {
            (Capacitor as { isNativePlatform: () => boolean }).isNativePlatform = () => true;
            await service.setSelectedMarianModel("fr-en-base");

            vi.mocked(MarianPlugin.translate).mockResolvedValue({ text: "Hello world" });

            const result = await service.translate("Bonjour le monde", "fr", "en");

            expect(MarianPlugin.translate).toHaveBeenCalledWith({
                text: "Bonjour le monde",
                model: "fr-en-base",
            });
            expect(result).toBe("Hello world");
        });

        it("uses the en-fr model for en → fr direction", async () => {
            (Capacitor as { isNativePlatform: () => boolean }).isNativePlatform = () => true;
            await service.setSelectedMarianModel("en-fr-base");

            vi.mocked(MarianPlugin.translate).mockResolvedValue({ text: "Bonjour" });

            await service.translate("Hello", "en", "fr");

            expect(MarianPlugin.translate).toHaveBeenCalledWith({
                text: "Hello",
                model: "en-fr-base",
            });
        });

        it("throws when MarianPlugin.translate returns an empty string", async () => {
            (Capacitor as { isNativePlatform: () => boolean }).isNativePlatform = () => true;
            vi.mocked(MarianPlugin.translate).mockResolvedValue({ text: "" });

            await expect(service.translate("Bonjour", "fr", "en")).rejects.toThrow(
                "MarianMT returned an empty translation."
            );
        });

        it("throws when MarianPlugin.translate returns a whitespace-only string", async () => {
            (Capacitor as { isNativePlatform: () => boolean }).isNativePlatform = () => true;
            vi.mocked(MarianPlugin.translate).mockResolvedValue({ text: "   " });

            await expect(service.translate("Bonjour", "fr", "en")).rejects.toThrow(
                "MarianMT returned an empty translation."
            );
        });

        it("propagates rejection from MarianPlugin.translate", async () => {
            (Capacitor as { isNativePlatform: () => boolean }).isNativePlatform = () => true;
            vi.mocked(MarianPlugin.translate).mockRejectedValue(new Error("Model not loaded"));

            await expect(service.translate("Bonjour", "fr", "en")).rejects.toThrow(
                "Model not loaded"
            );
        });
    });

    // ── TRANSLATION_REQUIRES_INTERNET constant ────────────────────────────────

    describe("TRANSLATION_REQUIRES_INTERNET", () => {
        it("marks 'mymemory' as requiring internet", async () => {
            const { TRANSLATION_REQUIRES_INTERNET } = await import("../services/translationService");
            expect(TRANSLATION_REQUIRES_INTERNET.mymemory).toBe(true);
        });

        it("marks 'marian' as not requiring internet", async () => {
            const { TRANSLATION_REQUIRES_INTERNET } = await import("../services/translationService");
            expect(TRANSLATION_REQUIRES_INTERNET.marian).toBe(false);
        });

        it("marks 'ollama' as not requiring internet", async () => {
            const { TRANSLATION_REQUIRES_INTERNET } = await import("../services/translationService");
            expect(TRANSLATION_REQUIRES_INTERNET.ollama).toBe(false);
        });

        it("marks 'libretranslate' as not requiring internet", async () => {
            const { TRANSLATION_REQUIRES_INTERNET } = await import("../services/translationService");
            expect(TRANSLATION_REQUIRES_INTERNET.libretranslate).toBe(false);
        });
    });
});
