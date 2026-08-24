import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockListDecks, mockSetKeyImage, mockAddListener } = vi.hoisted(() => ({
    mockListDecks: vi.fn(),
    mockSetKeyImage: vi.fn(),
    mockAddListener: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
    registerPlugin: () => ({
        listDecks: mockListDecks,
        setKeyImage: mockSetKeyImage,
        addListener: mockAddListener,
    }),
}));

import { StreamDeckPlugin, DeckInfo } from "../plugins/streamDeckPlugin";

describe("StreamDeckPlugin TS bridge", () => {
    beforeEach(() => {
        mockListDecks.mockReset();
        mockSetKeyImage.mockReset();
        mockAddListener.mockReset();
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
});
