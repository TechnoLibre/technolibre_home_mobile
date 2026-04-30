/**
 * Coverage for the Groq cloud branch in TranscriptionService —
 * the user can enable Groq Whisper from Options > Transcription
 * and route transcribe() through the Groq API instead of the
 * on-device whisper.cpp model. The native whisper path stays
 * untouched when Groq is disabled or the key is missing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TranscriptionService } from "../services/transcriptionService";
import { DatabaseService } from "../services/databaseService";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { Capacitor } from "@capacitor/core";
import { Events } from "../constants/events";

vi.mock("../plugins/whisperPlugin", () => ({
    WhisperPlugin: {
        isModelLoaded: vi.fn().mockResolvedValue({ loaded: true }),
        loadModel:     vi.fn().mockResolvedValue(undefined),
        getModelPath:  vi.fn().mockResolvedValue({ path: "/p", exists: true }),
        transcribe:    vi.fn().mockResolvedValue({ text: "local result" }),
        addListener:   vi.fn().mockResolvedValue({ remove: vi.fn() }),
    },
}));

vi.mock("@capacitor/filesystem", () => ({
    Filesystem: {
        readFile: vi.fn().mockResolvedValue({ data: "AAEC" }),  // base64
    },
    Directory: { Data: "DATA" },
}));

describe("TranscriptionService — Groq cloud branch", () => {
    let db: DatabaseService;
    let service: TranscriptionService;
    let fetchMock: any;

    beforeEach(async () => {
        SecureStoragePlugin._store.clear();
        db = new DatabaseService();
        await db.initialize();
        vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
        fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        service = new TranscriptionService(db);
    });

    it("exposes the enabled toggle as a graphic-pref", async () => {
        expect(await service.isGroqEnabled()).toBe(false);
        await service.setGroqEnabled(true);
        expect(await service.isGroqEnabled()).toBe(true);
        await service.setGroqEnabled(false);
        expect(await service.isGroqEnabled()).toBe(false);
    });

    it("stores the API key in secure-storage, not in graphic-prefs", async () => {
        await service.setGroqApiKey("gsk_secret123");
        expect(await service.getGroqApiKey()).toBe("gsk_secret123");
        // Graphic-prefs is the SQLite KV — the key must not leak there.
        expect(await db.getUserGraphicPref("whisper_groq_api_key")).toBe(null);
        // Removing via empty string clears it.
        await service.setGroqApiKey("");
        expect(await service.getGroqApiKey()).toBe("");
    });

    it("falls back to local whisper when Groq is enabled but the key is missing", async () => {
        await service.setGroqEnabled(true);
        // No key set.
        const text = await service.transcribe("audio.m4a", "fr", "n1", "e1");
        expect(text).toBe("local result");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("uses local whisper when Groq is disabled even if a key is set", async () => {
        await service.setGroqApiKey("gsk_x");
        await service.setGroqEnabled(false);
        const text = await service.transcribe("audio.m4a");
        expect(text).toBe("local result");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("posts to Groq's whisper endpoint with the key when enabled", async () => {
        await service.setGroqEnabled(true);
        await service.setGroqApiKey("gsk_secret");
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({ text: "Bonjour le monde" }),
        });
        const text = await service.transcribe("audio.m4a", "fr", "n1", "e1");
        expect(text).toBe("Bonjour le monde");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
        expect(init.method).toBe("POST");
        expect(init.headers.Authorization).toBe("Bearer gsk_secret");
        // Request body is FormData — verify it contains expected fields.
        expect(init.body).toBeInstanceOf(FormData);
    });

    it("propagates a Groq HTTP error with the body snippet", async () => {
        await service.setGroqEnabled(true);
        await service.setGroqApiKey("bad_key");
        fetchMock.mockResolvedValue({
            ok: false, status: 401,
            text: async () => '{"error":{"message":"Invalid API key"}}',
        });
        await expect(service.transcribe("audio.m4a", "fr", "n1", "e1"))
            .rejects.toThrow(/Groq HTTP 401.*Invalid API key/);
    });

    it("fires SET_ENTRY_TRANSCRIPTION on success when bus + entryId set", async () => {
        const trigger = vi.fn();
        service = new TranscriptionService(db, undefined, { trigger });
        await service.setGroqEnabled(true);
        await service.setGroqApiKey("gsk_secret");
        fetchMock.mockResolvedValue({
            ok: true, json: async () => ({ text: "from cloud" }),
        });
        await service.transcribe("audio.m4a", "fr", "n1", "e1");
        const [name, payload] = trigger.mock.calls[0];
        expect(name).toBe(Events.SET_ENTRY_TRANSCRIPTION);
        expect(payload).toMatchObject({
            entryId: "e1", text: "from cloud", noteId: "n1", audioPath: "audio.m4a",
        });
    });
});
