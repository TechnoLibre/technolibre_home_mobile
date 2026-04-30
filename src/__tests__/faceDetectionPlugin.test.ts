import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDetect } = vi.hoisted(() => ({ mockDetect: vi.fn() }));

vi.mock("@capacitor/core", () => ({
    registerPlugin: () => ({ detectFaces: mockDetect }),
}));

import { FaceDetectionPlugin, FaceBox } from "../plugins/faceDetectionPlugin";

describe("FaceDetectionPlugin TS bridge", () => {
    beforeEach(() => {
        mockDetect.mockReset();
    });

    it("forwards the JPEG payload to native and returns typed faces", async () => {
        const f: FaceBox = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
        mockDetect.mockResolvedValue({ faces: [f] });
        const r = await FaceDetectionPlugin.detectFaces({ jpegBase64: "AAA" });
        expect(r.faces).toHaveLength(1);
        expect(r.faces[0]).toEqual(f);
        expect(mockDetect).toHaveBeenCalledWith({ jpegBase64: "AAA" });
    });

    it("resolves with an empty array when no face is found", async () => {
        mockDetect.mockResolvedValue({ faces: [] });
        const r = await FaceDetectionPlugin.detectFaces({ jpegBase64: "BBB" });
        expect(r.faces).toEqual([]);
    });

    it("propagates a native decode error", async () => {
        mockDetect.mockRejectedValue(new Error("undecodable JPEG"));
        await expect(
            FaceDetectionPlugin.detectFaces({ jpegBase64: "" }),
        ).rejects.toThrow(/undecodable JPEG/);
    });
});
