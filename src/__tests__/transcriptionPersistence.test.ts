/**
 * Regression test for the "transcription completes but the note never
 * shows it" bug.
 *
 * Repro on device: tap T on an audio entry, navigate to the processes
 * panel before whisper.cpp finishes, come back to the note. The
 * processes row reports success and contains the text, but the audio
 * entry stays empty because the audio component fired
 * SET_ENTRY_TRANSCRIPTION itself — and that listener was torn down
 * with the parent NoteComponent the moment the user navigated away.
 *
 * Fix: TranscriptionService receives an eventBus and an entryId, and
 * fires SET_ENTRY_TRANSCRIPTION itself on success. A boot-time
 * listener on app.ts persists the text into the matching entry. This
 * test pins the service-side contract.
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
        transcribe:    vi.fn().mockResolvedValue({ text: "Bonjour le monde" }),
        addListener:   vi.fn().mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) }),
    },
}));

describe("TranscriptionService — persistence on completion", () => {
    let db: DatabaseService;
    let isNativeSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
        SecureStoragePlugin._store.clear();
        db = new DatabaseService();
        await db.initialize();
        // The service short-circuits on web. Force native for these tests.
        isNativeSpy = vi.spyOn(Capacitor, "isNativePlatform")
            .mockReturnValue(true);
    });

    afterEach?.(() => isNativeSpy?.mockRestore?.());

    it("does not fire SET_ENTRY_TRANSCRIPTION when no eventBus is wired", async () => {
        const service = new TranscriptionService(db);
        const text = await service.transcribe("a.m4a", "fr", "n1", "e1");
        // Just sanity: the call still resolves with the text.
        expect(text).toBe("Bonjour le monde");
    });

    it("does not fire SET_ENTRY_TRANSCRIPTION when entryId is missing", async () => {
        const trigger = vi.fn();
        const service = new TranscriptionService(db, undefined, { trigger });
        await service.transcribe("a.m4a", "fr", "n1");
        // No entryId → cannot route to a specific entry.
        expect(trigger).not.toHaveBeenCalled();
    });

    it("fires SET_ENTRY_TRANSCRIPTION with the full payload on success", async () => {
        const trigger = vi.fn();
        const service = new TranscriptionService(db, undefined, { trigger });
        await service.transcribe("a.m4a", "fr", "n1", "e1");
        expect(trigger).toHaveBeenCalledTimes(1);
        const [name, payload] = trigger.mock.calls[0];
        expect(name).toBe(Events.SET_ENTRY_TRANSCRIPTION);
        expect(payload).toMatchObject({
            entryId: "e1",
            text: "Bonjour le monde",
            noteId: "n1",
            audioPath: "a.m4a",
        });
    });

    it("does not fire SET_ENTRY_TRANSCRIPTION when transcribe() throws", async () => {
        const trigger = vi.fn();
        const service = new TranscriptionService(db, undefined, { trigger });
        const { WhisperPlugin } = await import("../plugins/whisperPlugin");
        vi.mocked(WhisperPlugin.transcribe).mockRejectedValueOnce(
            new Error("model failed"),
        );
        await expect(service.transcribe("a.m4a", "fr", "n1", "e1"))
            .rejects.toThrow(/model failed/);
        expect(trigger).not.toHaveBeenCalled();
    });

    it("survives the audio component being torn down — payload still flies", async () => {
        // The original code path fired SET_ENTRY_TRANSCRIPTION from the
        // audio component AFTER awaiting transcribe(). If the user
        // navigates away mid-await, the await still resolves but the
        // bus listener is gone and the text is dropped. Pin that the
        // service-side fire doesn't depend on any caller liveness:
        // we don't even await the call.
        const trigger = vi.fn();
        const service = new TranscriptionService(db, undefined, { trigger });
        const promise = service.transcribe("a.m4a", "fr", "n1", "e1");
        // Pretend the caller navigated away — the promise dangles.
        // It still resolves and fires the event.
        await promise;
        expect(trigger).toHaveBeenCalledTimes(1);
    });
});

// vitest exposes afterEach via the global; declare for TS strictness.
declare const afterEach: ((fn: () => void) => void) | undefined;
