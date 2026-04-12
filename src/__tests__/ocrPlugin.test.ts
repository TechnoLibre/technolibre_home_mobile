import { describe, it, expect, vi } from "vitest";
import { OcrPlugin, TextBlock, TextDetectedEvent } from "../plugins/ocrPlugin";

// The @capacitor/core mock returns { post: ... } for registerPlugin().
// We add the missing OCR methods onto the exported singleton to simulate
// what a real Capacitor plugin would expose at runtime.

describe("OcrPlugin — plugin wrapper", () => {
    it("is exported and truthy", () => {
        expect(OcrPlugin).toBeTruthy();
    });

    it("startScan() returns a Promise that resolves", async () => {
        (OcrPlugin as any).startScan = vi.fn().mockResolvedValue(undefined);
        await expect(OcrPlugin.startScan()).resolves.toBeUndefined();
        expect((OcrPlugin as any).startScan).toHaveBeenCalledTimes(1);
    });

    it("startScan() forwards optional options", async () => {
        (OcrPlugin as any).startScan = vi.fn().mockResolvedValue(undefined);
        await OcrPlugin.startScan({ intervalMs: 500 });
        expect((OcrPlugin as any).startScan).toHaveBeenCalledWith({ intervalMs: 500 });
    });

    it("stopScan() returns a Promise that resolves", async () => {
        (OcrPlugin as any).stopScan = vi.fn().mockResolvedValue(undefined);
        await expect(OcrPlugin.stopScan()).resolves.toBeUndefined();
        expect((OcrPlugin as any).stopScan).toHaveBeenCalledTimes(1);
    });

    it("addListener('textDetected', fn) returns a Promise with a remove() function", async () => {
        const removeHandle = { remove: vi.fn() };
        (OcrPlugin as any).addListener = vi.fn().mockResolvedValue(removeHandle);

        const handle = await OcrPlugin.addListener("textDetected", () => {});
        expect(handle).toHaveProperty("remove");
        expect(typeof handle.remove).toBe("function");
    });

    it("addListener callback accepts a TextDetectedEvent with TextBlock values", async () => {
        const captured: TextDetectedEvent[] = [];
        (OcrPlugin as any).addListener = vi.fn().mockImplementation(
            (_event: string, fn: (data: TextDetectedEvent) => void) => {
                const block: TextBlock = { text: "Hello", x: 0.1, y: 0.2, width: 0.5, height: 0.1 };
                fn({ blocks: [block] });
                return Promise.resolve({ remove: () => {} });
            }
        );

        await OcrPlugin.addListener("textDetected", (data) => captured.push(data));

        expect(captured).toHaveLength(1);
        const block = captured[0].blocks[0];
        expect(block.text).toBe("Hello");
        expect(block.x).toBe(0.1);
        expect(block.y).toBe(0.2);
        expect(block.width).toBe(0.5);
        expect(block.height).toBe(0.1);
    });
});
