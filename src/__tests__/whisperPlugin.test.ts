import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockApi } = vi.hoisted(() => ({
    mockApi: {
        isModelLoaded: vi.fn(),
        loadModel: vi.fn(),
        getModelPath: vi.fn(),
        downloadModel: vi.fn(),
        downloadModelForeground: vi.fn(),
        getServiceStatus: vi.fn(),
        cancelDownload: vi.fn(),
        transcribe: vi.fn(),
        unloadModel: vi.fn(),
        deleteModel: vi.fn(),
        addListener: vi.fn(),
    },
}));

vi.mock("@capacitor/core", () => ({
    registerPlugin: () => mockApi,
}));

import { WhisperPlugin } from "../plugins/whisperPlugin";

describe("WhisperPlugin TS bridge", () => {
    beforeEach(() => {
        Object.values(mockApi).forEach((m: any) => m.mockReset?.());
    });

    it("isModelLoaded returns the typed flag", async () => {
        mockApi.isModelLoaded.mockResolvedValue({ loaded: true });
        expect((await WhisperPlugin.isModelLoaded()).loaded).toBe(true);
    });

    it("loadModel forwards the model name", async () => {
        mockApi.loadModel.mockResolvedValue(undefined);
        await WhisperPlugin.loadModel({ model: "base" });
        expect(mockApi.loadModel).toHaveBeenCalledWith({ model: "base" });
    });

    it("getModelPath returns existence + path", async () => {
        mockApi.getModelPath.mockResolvedValue({
            path: "/data/whisper/base.bin", exists: true,
        });
        const r = await WhisperPlugin.getModelPath({ model: "base" });
        expect(r).toEqual({ path: "/data/whisper/base.bin", exists: true });
    });

    it("downloadModel returns the on-disk path", async () => {
        mockApi.downloadModel.mockResolvedValue({ path: "/p/large-v3-turbo.bin" });
        const r = await WhisperPlugin.downloadModel({
            model: "large-v3-turbo", url: "https://x/large.bin",
        });
        expect(r.path).toBe("/p/large-v3-turbo.bin");
        expect(mockApi.downloadModel).toHaveBeenCalledWith({
            model: "large-v3-turbo", url: "https://x/large.bin",
        });
    });

    it("downloadModelForeground is a separate API for ≥1 GB models", async () => {
        mockApi.downloadModelForeground.mockResolvedValue({ path: "/p/m.bin" });
        await WhisperPlugin.downloadModelForeground({
            model: "medium", url: "https://x/medium.bin",
        });
        expect(mockApi.downloadModelForeground).toHaveBeenCalled();
        expect(mockApi.downloadModel).not.toHaveBeenCalled();
    });

    it("getServiceStatus reports active downloads for reconnect", async () => {
        mockApi.getServiceStatus.mockResolvedValue({
            downloading: true, model: "small",
        });
        const r = await WhisperPlugin.getServiceStatus();
        expect(r.downloading).toBe(true);
        expect(r.model).toBe("small");
    });

    it("cancelDownload accepts no args and a model arg", async () => {
        mockApi.cancelDownload.mockResolvedValue(undefined);
        await WhisperPlugin.cancelDownload();
        expect(mockApi.cancelDownload).toHaveBeenCalledWith();
        await WhisperPlugin.cancelDownload({ model: "base" });
        expect(mockApi.cancelDownload).toHaveBeenLastCalledWith({ model: "base" });
    });

    it("transcribe forwards path and optional language", async () => {
        mockApi.transcribe.mockResolvedValue({ text: "hello" });
        const r = await WhisperPlugin.transcribe({ audioPath: "/p.wav", lang: "fr" });
        expect(r.text).toBe("hello");
        expect(mockApi.transcribe).toHaveBeenCalledWith({
            audioPath: "/p.wav", lang: "fr",
        });
    });

    it("unloadModel and deleteModel resolve void", async () => {
        mockApi.unloadModel.mockResolvedValue(undefined);
        mockApi.deleteModel.mockResolvedValue(undefined);
        await expect(WhisperPlugin.unloadModel()).resolves.toBeUndefined();
        await WhisperPlugin.deleteModel({ model: "tiny" });
        expect(mockApi.deleteModel).toHaveBeenCalledWith({ model: "tiny" });
    });

    it("addListener wires progress and downloadProgress", async () => {
        mockApi.addListener.mockResolvedValue({ remove: vi.fn() });
        const a = vi.fn(), b = vi.fn();
        await WhisperPlugin.addListener("progress", a);
        await WhisperPlugin.addListener("downloadProgress", b);
        expect(mockApi.addListener).toHaveBeenNthCalledWith(1, "progress", a);
        expect(mockApi.addListener).toHaveBeenNthCalledWith(2, "downloadProgress", b);
    });
});
