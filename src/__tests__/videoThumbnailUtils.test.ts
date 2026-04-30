import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface FakeVideo {
    src: string;
    muted: boolean;
    playsInline: boolean;
    videoWidth: number;
    videoHeight: number;
    currentTime: number;
    addEventListener: (name: string, fn: () => void) => void;
    _fire: (name: string) => void;
}

function makeFakeVideo(over: Partial<FakeVideo> = {}): FakeVideo {
    const listeners: Record<string, Array<() => void>> = {};
    return {
        src: "",
        muted: false,
        playsInline: false,
        videoWidth: 1920,
        videoHeight: 1080,
        currentTime: 0,
        addEventListener(name, fn) {
            (listeners[name] ??= []).push(fn);
        },
        _fire(name) {
            for (const fn of listeners[name] ?? []) fn();
        },
        ...over,
    };
}

function makeFakeCanvas(opts: { ctx?: any | null; dataUrl?: string } = {}) {
    const ctx = opts.ctx === undefined ? { drawImage: vi.fn() } : opts.ctx;
    return {
        width: 0, height: 0,
        getContext: vi.fn(() => ctx),
        toDataURL: vi.fn(() => opts.dataUrl ?? "data:image/jpeg;base64,QUJD"),
    };
}

let fakeVideo: FakeVideo;
let fakeCanvas: ReturnType<typeof makeFakeCanvas>;

function stubDom(opts: {
    video?: FakeVideo;
    canvas?: ReturnType<typeof makeFakeCanvas>;
} = {}) {
    fakeVideo = opts.video ?? makeFakeVideo();
    fakeCanvas = opts.canvas ?? makeFakeCanvas();
    vi.stubGlobal("document", {
        createElement: vi.fn((tag: string) => {
            if (tag === "video") return fakeVideo;
            if (tag === "canvas") return fakeCanvas;
            throw new Error(`unexpected createElement(${tag})`);
        }),
    });
}

import { generateVideoThumbnail } from "../utils/videoThumbnailUtils";

describe("generateVideoThumbnail", () => {
    beforeEach(() => stubDom());
    afterEach(() => vi.unstubAllGlobals());

    it("seeks to 0.1 s on loadedmetadata", async () => {
        const p = generateVideoThumbnail("file://x.mp4");
        fakeVideo._fire("loadedmetadata");
        expect(fakeVideo.currentTime).toBe(0.1);
        // resolve the promise so it doesn't leak
        fakeVideo._fire("seeked");
        await p;
    });

    it("returns the base64 portion (no data: prefix)", async () => {
        const p = generateVideoThumbnail("file://x.mp4");
        fakeVideo._fire("loadedmetadata");
        fakeVideo._fire("seeked");
        expect(await p).toBe("QUJD");
    });

    it("uses the video's intrinsic resolution when present", async () => {
        stubDom({ video: makeFakeVideo({ videoWidth: 320, videoHeight: 240 }) });
        const p = generateVideoThumbnail("file://x.mp4");
        fakeVideo._fire("loadedmetadata");
        fakeVideo._fire("seeked");
        await p;
        expect(fakeCanvas.width).toBe(320);
        expect(fakeCanvas.height).toBe(240);
    });

    it("falls back to 1280×720 when video reports 0×0", async () => {
        stubDom({ video: makeFakeVideo({ videoWidth: 0, videoHeight: 0 }) });
        const p = generateVideoThumbnail("file://x.mp4");
        fakeVideo._fire("loadedmetadata");
        fakeVideo._fire("seeked");
        await p;
        expect(fakeCanvas.width).toBe(1280);
        expect(fakeCanvas.height).toBe(720);
    });

    it("rejects when getContext returns null", async () => {
        stubDom({ canvas: makeFakeCanvas({ ctx: null }) });
        const p = generateVideoThumbnail("file://x.mp4");
        fakeVideo._fire("loadedmetadata");
        fakeVideo._fire("seeked");
        await expect(p).rejects.toThrow(/Canvas 2D context unavailable/);
    });

    it("rejects with the URL on a video error", async () => {
        const p = generateVideoThumbnail("file://broken.mp4");
        fakeVideo._fire("error");
        await expect(p).rejects.toThrow(/Video load error for: file:\/\/broken\.mp4/);
    });

    it("encodes JPEG at quality 0.75", async () => {
        const p = generateVideoThumbnail("file://x.mp4");
        fakeVideo._fire("loadedmetadata");
        fakeVideo._fire("seeked");
        await p;
        expect(fakeCanvas.toDataURL).toHaveBeenCalledWith("image/jpeg", 0.75);
    });

    it("sets src after listeners are registered", async () => {
        const p = generateVideoThumbnail("file://y.mp4");
        // src is assigned synchronously inside the Promise executor.
        expect(fakeVideo.src).toBe("file://y.mp4");
        fakeVideo._fire("loadedmetadata");
        fakeVideo._fire("seeked");
        await p;
    });

    it("mutes and sets playsInline (for autoplay-restricted browsers)", async () => {
        const p = generateVideoThumbnail("file://x.mp4");
        expect(fakeVideo.muted).toBe(true);
        expect(fakeVideo.playsInline).toBe(true);
        fakeVideo._fire("loadedmetadata");
        fakeVideo._fire("seeked");
        await p;
    });
});
