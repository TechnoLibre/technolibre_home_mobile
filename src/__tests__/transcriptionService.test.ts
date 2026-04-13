import { describe, it, expect, beforeEach, vi } from "vitest";
import { TranscriptionService } from "../services/transcriptionService";
import { DatabaseService } from "../services/databaseService";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";

// vi.mock is hoisted to the top of the file, so the factory must not reference
// const/let declared below it. Use vi.fn() inline; grab refs via vi.mocked() later.
vi.mock("../plugins/whisperPlugin", () => ({
    WhisperPlugin: {
        isModelLoaded:  vi.fn().mockResolvedValue({ loaded: false }),
        loadModel:      vi.fn().mockResolvedValue(undefined),
        getModelPath:   vi.fn().mockResolvedValue({ path: "/data/whisper/ggml-tiny.bin", exists: true }),
        downloadModel:  vi.fn().mockResolvedValue({ path: "/data/whisper/ggml-tiny.bin" }),
        transcribe:     vi.fn().mockResolvedValue({ text: "Bonjour le monde" }),
        unloadModel:    vi.fn().mockResolvedValue(undefined),
        addListener:    vi.fn().mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) }),
    },
}));

// Re-import the mocked module to access individual spies.
import { WhisperPlugin } from "../plugins/whisperPlugin";

describe("TranscriptionService", () => {
    let db: DatabaseService;
    let service: TranscriptionService;

    beforeEach(async () => {
        vi.clearAllMocks();
        // Reset addListener's default resolved value after clearAllMocks resets it
        vi.mocked(WhisperPlugin.addListener).mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) });
        vi.mocked(WhisperPlugin.downloadModel).mockResolvedValue({ path: "/data/whisper/ggml-tiny.bin" });
        vi.mocked(WhisperPlugin.isModelLoaded).mockResolvedValue({ loaded: false });

        SecureStoragePlugin._store.clear();
        db = new DatabaseService();
        await db.initialize();
        service = new TranscriptionService(db);
    });

    // ── isEnabled / setEnabled ────────────────────────────────────────────────

    describe("isEnabled / setEnabled", () => {
        it("returns false by default (no pref stored)", async () => {
            expect(await service.isEnabled()).toBe(false);
        });

        it("persists enabled=true and reads it back", async () => {
            await service.setEnabled(true);
            expect(await service.isEnabled()).toBe(true);
        });

        it("persists enabled=false and reads it back", async () => {
            await service.setEnabled(true);
            await service.setEnabled(false);
            expect(await service.isEnabled()).toBe(false);
        });
    });

    // ── getSelectedModel / setSelectedModel ───────────────────────────────────

    describe("getSelectedModel / setSelectedModel", () => {
        it("returns 'tiny' by default (no pref stored)", async () => {
            expect(await service.getSelectedModel()).toBe("tiny");
        });

        it("persists 'small' and reads it back", async () => {
            await service.setSelectedModel("small");
            expect(await service.getSelectedModel()).toBe("small");
        });

        it("persists 'tiny' and reads it back", async () => {
            await service.setSelectedModel("small");
            await service.setSelectedModel("tiny");
            expect(await service.getSelectedModel()).toBe("tiny");
        });

        it("falls back to 'tiny' for an unknown stored value", async () => {
            // Bypass setSelectedModel to inject a garbage value directly
            await db.setUserGraphicPref("whisper_model", "unknown_model_xyz");
            expect(await service.getSelectedModel()).toBe("tiny");
        });
    });

    // ── isModelDownloaded ─────────────────────────────────────────────────────

    describe("isModelDownloaded", () => {
        it("returns false on web platform (Capacitor.isNativePlatform() = false)", async () => {
            // The @capacitor/core mock always returns isNativePlatform() = false,
            // so the guard returns early without ever calling the plugin.
            expect(await service.isModelDownloaded("tiny")).toBe(false);
            expect(WhisperPlugin.getModelPath).not.toHaveBeenCalled();
        });

        it("returns false while the model is being downloaded (partial file on disk)", async () => {
            // Java creates the file at the start of the download (FileOutputStream),
            // so file.exists() returns true even for an incomplete binary.
            // isModelDownloaded must return false while _activeDownloads has the model.
            let resultDuringDownload: boolean | undefined;

            vi.mocked(WhisperPlugin.addListener).mockImplementationOnce(
                async (_event: string, fn: (data: any) => void) => {
                    fn({ model: "tiny", ratio: 0.5, received: 50_000, total: 100_000 });
                    resultDuringDownload = await service.isModelDownloaded("tiny");
                    return { remove: vi.fn().mockResolvedValue(undefined) };
                }
            );

            await service.downloadModel("tiny");
            expect(resultDuringDownload).toBe(false);
            // After completion, _activeDownloads is empty — back to normal behaviour.
            expect(service.activeDownload).toBeNull();
        });
    });

    // ── downloadModel ─────────────────────────────────────────────────────────

    describe("downloadModel", () => {
        it("attaches a downloadProgress listener before calling the native plugin", async () => {
            await service.downloadModel("tiny");
            expect(WhisperPlugin.addListener).toHaveBeenCalledWith(
                "downloadProgress",
                expect.any(Function)
            );
            expect(WhisperPlugin.downloadModel).toHaveBeenCalledWith({
                model: "tiny",
                url: expect.stringContaining("ggml-tiny.bin"),
            });
        });

        it("removes the listener after successful download", async () => {
            const mockRemove = vi.fn().mockResolvedValue(undefined);
            vi.mocked(WhisperPlugin.addListener).mockResolvedValueOnce({ remove: mockRemove });
            await service.downloadModel("tiny");
            expect(mockRemove).toHaveBeenCalledTimes(1);
        });

        it("removes the listener even when the native plugin rejects", async () => {
            const mockRemove = vi.fn().mockResolvedValue(undefined);
            vi.mocked(WhisperPlugin.addListener).mockResolvedValueOnce({ remove: mockRemove });
            vi.mocked(WhisperPlugin.downloadModel).mockRejectedValueOnce(new Error("Network error"));

            await expect(service.downloadModel("tiny")).rejects.toThrow("Network error");
            expect(mockRemove).toHaveBeenCalledTimes(1);
        });

        it("notifies subscribeProgress callbacks with progress updates", async () => {
            const sub = vi.fn();
            const mockRemove = vi.fn().mockResolvedValue(undefined);

            vi.mocked(WhisperPlugin.addListener).mockImplementationOnce(
                async (_event: string, fn: (data: any) => void) => {
                    fn({ model: "tiny", ratio: 0.5, received: 50_000, total: 100_000 });
                    return { remove: mockRemove };
                }
            );

            const unsub = service.subscribeProgress(sub);
            await service.downloadModel("tiny");
            unsub();

            // Called with progress (50%) then null on completion
            expect(sub).toHaveBeenCalledWith(
                expect.objectContaining({ model: "tiny", percent: 50, mode: "wakelock" }),
                "tiny"
            );
            expect(sub).toHaveBeenLastCalledWith(null, "tiny");
        });

        it("exposes activeDownload during download and clears it after", async () => {
            let capturedDuring: any = undefined;
            vi.mocked(WhisperPlugin.addListener).mockImplementationOnce(
                async (_event: string, fn: (data: any) => void) => {
                    fn({ model: "tiny", ratio: 0.3, received: 30_000, total: 100_000 });
                    capturedDuring = service.activeDownload;
                    return { remove: vi.fn().mockResolvedValue(undefined) };
                }
            );

            await service.downloadModel("tiny");
            expect(capturedDuring).toEqual(expect.objectContaining({ model: "tiny", percent: 30, mode: "wakelock" }));
            expect(service.activeDownload).toBeNull();
        });

        it("uses the correct HuggingFace URL for the 'small' model", async () => {
            await service.downloadModel("small");
            expect(WhisperPlugin.downloadModel).toHaveBeenCalledWith({
                model: "small",
                url: expect.stringContaining("ggml-small.bin"),
            });
        });

        it("ignores a second downloadModel call for the same model while already downloading", async () => {
            let secondCallCount = 0;
            const firstInFlight = service.downloadModel("tiny");
            // Call again for the same model — should be a no-op.
            const secondCall = service.downloadModel("tiny").then(() => { secondCallCount++; });
            await Promise.all([firstInFlight, secondCall]);
            // downloadModel (native) should have been called only once.
            expect(WhisperPlugin.downloadModel).toHaveBeenCalledTimes(1);
        });

        it("allows concurrent downloads for different models", async () => {
            const mockRemoveSmall = vi.fn().mockResolvedValue(undefined);
            vi.mocked(WhisperPlugin.addListener).mockResolvedValue({ remove: mockRemoveSmall });
            vi.mocked(WhisperPlugin.downloadModel).mockResolvedValue({ path: "/data/whisper/ggml-tiny.bin" });

            await Promise.all([
                service.downloadModel("tiny"),
                service.downloadModel("small"),
            ]);
            // Each model should have triggered a separate native call.
            expect(WhisperPlugin.downloadModel).toHaveBeenCalledTimes(2);
        });

        it("falls back to wakelock when foreground is already active for a different model", async () => {
            // Start a foreground download for 'tiny' without awaiting it.
            const downloadModelForeground = vi.fn().mockResolvedValue({ path: "" });
            (WhisperPlugin as any).downloadModelForeground = downloadModelForeground;

            // Simulate foreground-mode download in-flight for 'tiny'.
            // We inject it directly into _activeDownloads to avoid timing issues.
            const activeMap = (service as any)._activeDownloads as Map<string, any>;
            activeMap.set("tiny", { model: "tiny", percent: 10, mode: "foreground",
                                    receivedBytes: 0, totalBytes: 0, speedBytesPerSec: 0 });

            // Now request a foreground download for 'small' — should fall back to wakelock.
            await service.downloadModel("small", "foreground");

            // The effective mode stored in activeDownloads was 'wakelock', so the
            // native wakelock call (not foreground) was used.
            expect(WhisperPlugin.downloadModel).toHaveBeenCalledWith(
                expect.objectContaining({ model: "small" })
            );
            expect(downloadModelForeground).not.toHaveBeenCalled();

            activeMap.delete("tiny");
        });
    });

    // ── transcribe ────────────────────────────────────────────────────────────

    describe("transcribe", () => {
        it("throws on web platform (isNativePlatform() = false)", async () => {
            await expect(service.transcribe("recording.m4a")).rejects.toThrow(
                "La transcription n'est disponible que sur Android."
            );
        });

        it("does not call WhisperPlugin when on web", async () => {
            await expect(service.transcribe("recording.m4a")).rejects.toThrow();
            expect(WhisperPlugin.isModelLoaded).not.toHaveBeenCalled();
            expect(WhisperPlugin.transcribe).not.toHaveBeenCalled();
        });
    });
});
