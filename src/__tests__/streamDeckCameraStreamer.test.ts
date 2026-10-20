import { describe, it, expect, vi } from "vitest";

vi.mock("@capacitor/camera", () => ({ Camera: {} }));
vi.mock("../plugins/streamDeckPlugin", () => ({ StreamDeckPlugin: {} }));
vi.mock("../plugins/faceDetectionPlugin", () => ({ FaceDetectionPlugin: {} }));

vi.stubGlobal("document", { addEventListener: vi.fn() });

import { StreamDeckCameraStreamer } from "../services/streamDeckCameraStreamer";

describe("StreamDeckCameraStreamer default border ratio", () => {
    const streamer = new StreamDeckCameraStreamer({} as any);

    it("gives the XL v2 the XL's ratio, not the generic fallback", () => {
        // Same 8x4 grid of 96 px keys behind the same cap: the python
        // StreamDeck library drives PID 0x008f with its StreamDeckXL class.
        expect(streamer.getDefaultBorderRatio("xl_v2"))
            .toEqual(streamer.getDefaultBorderRatio("xl"));
        expect(streamer.getDefaultBorderRatio("xl_v2")).toEqual({ w: 0.54, h: 0.54 });
    });
});
