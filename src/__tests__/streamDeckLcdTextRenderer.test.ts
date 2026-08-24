import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../plugins/streamDeckPlugin", () => ({
    StreamDeckPlugin: {
        listDecks: vi.fn().mockResolvedValue({ decks: [] }),
        getDeckInfo: vi.fn(),
        addListener: vi.fn(async () => ({ remove: vi.fn() })),
        setLcdImage: vi.fn().mockResolvedValue(undefined),
    },
    DeckInfo: {} as any,
}));

import { StreamDeckLcdTextRenderer } from "../services/streamDeckLcdTextRenderer";

describe("StreamDeckLcdTextRenderer config", () => {
    let r: StreamDeckLcdTextRenderer;
    beforeEach(() => {
        r = new StreamDeckLcdTextRenderer();
    });

    describe("defaults", () => {
        it("starts with empty text, 48 px font, white, 2 px/tick scroll", () => {
            expect(r.getText("AL01")).toBe("");
            expect(r.getFontSize("AL01")).toBe(48);
            expect(r.getColor("AL01")).toBe("#ffffff");
            expect(r.getScrollSpeed("AL01")).toBe(2);
        });

        it("isolates configuration per deck", () => {
            r.setText("AL01", "hello");
            r.setText("AL02", "world");
            expect(r.getText("AL01")).toBe("hello");
            expect(r.getText("AL02")).toBe("world");
        });
    });

    describe("setText", () => {
        it("stores the text verbatim", () => {
            r.setText("AL01", "Marquee 🌈");
            expect(r.getText("AL01")).toBe("Marquee 🌈");
        });
    });

    describe("setFontSize", () => {
        it("clamps to 8–120 and rounds", () => {
            r.setFontSize("AL01", 200);
            expect(r.getFontSize("AL01")).toBe(120);
            r.setFontSize("AL01", 1);
            expect(r.getFontSize("AL01")).toBe(8);
            r.setFontSize("AL01", 36.6);
            expect(r.getFontSize("AL01")).toBe(37);
        });
    });

    describe("setColor", () => {
        it("stores the value as-is (no validation)", () => {
            r.setColor("AL01", "#ff0080");
            expect(r.getColor("AL01")).toBe("#ff0080");
            r.setColor("AL01", "rgb(0, 0, 0)");
            expect(r.getColor("AL01")).toBe("rgb(0, 0, 0)");
        });
    });

    describe("setScrollSpeed", () => {
        it("clamps to 0–30 and rounds", () => {
            r.setScrollSpeed("AL01", -5);
            expect(r.getScrollSpeed("AL01")).toBe(0);
            r.setScrollSpeed("AL01", 99);
            expect(r.getScrollSpeed("AL01")).toBe(30);
            r.setScrollSpeed("AL01", 7.7);
            expect(r.getScrollSpeed("AL01")).toBe(8);
        });
    });

    describe("hasLcd", () => {
        it("returns false for a deck not seen via listDecks", () => {
            expect(r.hasLcd("AL01")).toBe(false);
        });
    });
});
