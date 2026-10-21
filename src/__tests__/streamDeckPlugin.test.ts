import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockListDecks, mockSetKeyImage, mockAddListener, mockRequestPermission } = vi.hoisted(() => ({
    mockListDecks: vi.fn(),
    mockSetKeyImage: vi.fn(),
    mockAddListener: vi.fn(),
    mockRequestPermission: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
    registerPlugin: () => ({
        listDecks: mockListDecks,
        setKeyImage: mockSetKeyImage,
        addListener: mockAddListener,
        requestPermission: mockRequestPermission,
    }),
}));

import {
    StreamDeckPlugin,
    DeckInfo,
    DeckPermissionResponse,
    describePermissionResponse,
} from "../plugins/streamDeckPlugin";

describe("StreamDeckPlugin TS bridge", () => {
    beforeEach(() => {
        mockListDecks.mockReset();
        mockSetKeyImage.mockReset();
        mockAddListener.mockReset();
        mockRequestPermission.mockReset();
    });

    it("listDecks returns typed DeckInfo array", async () => {
        const sample: DeckInfo = {
            deckId: "AL01",
            model: "mk2",
            productId: 0x0080,
            rows: 3,
            cols: 5,
            keyCount: 15,
            keyImage: { w: 72, h: 72, format: "jpeg" },
            dialCount: 0,
            touchPoints: 0,
            firmwareVersion: "1.0",
            controlPipeOk: true,
            capabilities: ["keys"],
        };
        mockListDecks.mockResolvedValue({ decks: [sample] });
        const r = await StreamDeckPlugin.listDecks();
        expect(r.decks).toHaveLength(1);
        expect(r.decks[0].model).toBe("mk2");
        expect(r.decks[0].keyCount).toBe(15);
    });

    it("setKeyImage forwards base64 + format to native", async () => {
        mockSetKeyImage.mockResolvedValue({ dropped: false });
        const r = await StreamDeckPlugin.setKeyImage({
            deckId: "AL01",
            key: 3,
            bytes: "QkFTRTY0",
            format: "jpeg",
        });
        expect(r.dropped).toBe(false);
        expect(mockSetKeyImage).toHaveBeenCalledWith({
            deckId: "AL01",
            key: 3,
            bytes: "QkFTRTY0",
            format: "jpeg",
        });
    });

    it("setKeyImage surfaces dropped=true when coalesced", async () => {
        mockSetKeyImage.mockResolvedValue({ dropped: true });
        const r = await StreamDeckPlugin.setKeyImage({
            deckId: "AL01", key: 0, bytes: "AA==", format: "jpeg",
        });
        expect(r.dropped).toBe(true);
    });

    it("addListener wires keyChanged events", async () => {
        const handler = vi.fn();
        mockAddListener.mockResolvedValue({ remove: vi.fn() });
        await StreamDeckPlugin.addListener("keyChanged", handler);
        expect(mockAddListener).toHaveBeenCalledWith("keyChanged", handler);
    });

    it("requestPermission without a deckId asks for every attached deck", async () => {
        const answer: DeckPermissionResponse = {
            granted: false,
            results: [
                { deviceName: "/dev/bus/usb/001/002", deckId: "AL01",
                  outcome: "already_granted", granted: true },
                { deviceName: "/dev/bus/usb/001/003", deckId: "",
                  outcome: "timeout", granted: false, error: "permission_timeout" },
            ],
        };
        mockRequestPermission.mockResolvedValue(answer);
        const r = await StreamDeckPlugin.requestPermission();
        expect(mockRequestPermission).toHaveBeenCalledWith();
        expect(r.granted).toBe(false);
        expect(r.results.map((x) => x.outcome)).toEqual(["already_granted", "timeout"]);
    });

    it("requestPermission keeps the deckId form and its granted flag", async () => {
        mockRequestPermission.mockResolvedValue({
            granted: true,
            results: [{ deviceName: "/dev/bus/usb/001/002", deckId: "AL01",
                        outcome: "granted", granted: true }],
        });
        const r = await StreamDeckPlugin.requestPermission({ deckId: "AL01" });
        expect(mockRequestPermission).toHaveBeenCalledWith({ deckId: "AL01" });
        expect(r.granted).toBe(true);
    });
});

describe("describePermissionResponse", () => {
    it("names each device with its outcome and the reason of a failure", () => {
        const lines = describePermissionResponse({
            granted: false,
            results: [
                { deviceName: "/dev/bus/usb/001/002", deckId: "AL01",
                  outcome: "granted", granted: true },
                { deviceName: "/dev/bus/usb/001/003", deckId: "",
                  outcome: "denied", granted: false },
                { deviceName: "/dev/bus/usb/001/004", deckId: "",
                  outcome: "error", granted: false, error: "boom" },
            ],
        });
        expect(lines).toEqual([
            "/dev/bus/usb/001/002 (AL01) → granted",
            "/dev/bus/usb/001/003 → denied",
            "/dev/bus/usb/001/004 → error: boom",
        ]);
    });

    it("reads a response from an older native side that lacks results", () => {
        expect(describePermissionResponse({ granted: true } as DeckPermissionResponse))
            .toEqual(["granted=true"]);
    });
});
