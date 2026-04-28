import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSendIntent } = vi.hoisted(() => ({
    mockSendIntent: {
        checkSendIntentReceived: vi.fn(),
    },
}));

vi.mock("@supernotes/capacitor-send-intent", () => ({
    SendIntent: mockSendIntent,
}));

import { EventBus } from "@odoo/owl";
import { IntentService } from "../services/intentService";
import { Events } from "../constants/events";
import {
    ImageIntent,
    TextIntent,
    VideoIntent,
} from "../models/intent";

describe("IntentService", () => {
    beforeEach(() => {
        mockSendIntent.checkSendIntentReceived.mockReset();
        // Default: no pending intent. Concrete tests override before
        // constructing the service.
        mockSendIntent.checkSendIntentReceived.mockResolvedValue(null);
    });

    describe("getBroadType", () => {
        it("returns the prefix before the slash", () => {
            const svc = new IntentService(new EventBus());
            expect(svc.getBroadType("text/plain")).toBe("text");
            expect(svc.getBroadType("image/jpeg")).toBe("image");
            expect(svc.getBroadType("video/mp4")).toBe("video");
        });
        it("returns undefined for missing or non-MIME input", () => {
            const svc = new IntentService(new EventBus());
            expect(svc.getBroadType(undefined)).toBeUndefined();
            expect(svc.getBroadType("")).toBeUndefined();
            expect(svc.getBroadType("plaintext")).toBeUndefined();
        });
    });

    describe("isIntentType", () => {
        it("accepts text / image / video only", () => {
            const svc = new IntentService(new EventBus());
            expect(svc.isIntentType("text")).toBe(true);
            expect(svc.isIntentType("image")).toBe(true);
            expect(svc.isIntentType("video")).toBe(true);
            expect(svc.isIntentType("audio")).toBe(false);
            expect(svc.isIntentType(undefined)).toBe(false);
            expect(svc.isIntentType("")).toBe(false);
        });
    });

    describe("from", () => {
        it("builds a TextIntent for text/* MIME", () => {
            const svc = new IntentService(new EventBus());
            const out = svc.from({ type: "text/plain", url: "hello world" } as any);
            expect(out).toBeInstanceOf(TextIntent);
            expect((out as TextIntent).text).toBe("hello world");
            expect(out!.mimeType).toBe("text/plain");
            expect(out!.type).toBe("text");
        });
        it("builds an ImageIntent for image/* MIME", () => {
            const svc = new IntentService(new EventBus());
            const out = svc.from({ type: "image/jpeg", url: "file:///photo.jpg" } as any);
            expect(out).toBeInstanceOf(ImageIntent);
            expect((out as ImageIntent).url).toBe("file:///photo.jpg");
            expect(out!.type).toBe("image");
        });
        it("builds a VideoIntent for video/* MIME", () => {
            const svc = new IntentService(new EventBus());
            const out = svc.from({ type: "video/mp4", url: "file:///clip.mp4" } as any);
            expect(out).toBeInstanceOf(VideoIntent);
            expect((out as VideoIntent).url).toBe("file:///clip.mp4");
            expect(out!.type).toBe("video");
        });
        it("returns nothing when MIME prefix is unsupported", () => {
            const svc = new IntentService(new EventBus());
            expect(svc.from({ type: "audio/mp3", url: "x" } as any)).toBeUndefined();
        });
        it("returns nothing when type or url are missing", () => {
            const svc = new IntentService(new EventBus());
            expect(svc.from({ type: "", url: "x" } as any)).toBeUndefined();
            expect(svc.from({ type: "text/plain", url: "" } as any)).toBeUndefined();
        });
    });

    describe("intent state", () => {
        it("starts undefined and clearIntent resets it", () => {
            const svc = new IntentService(new EventBus());
            expect(svc.intent).toBeUndefined();
            svc.intent = new TextIntent("text/plain", "x");
            expect(svc.intent).toBeInstanceOf(TextIntent);
            svc.clearIntent();
            expect(svc.intent).toBeUndefined();
        });
    });

    describe("listenForIntents (via constructor)", () => {
        it("captures a pending text intent and triggers a router nav", async () => {
            mockSendIntent.checkSendIntentReceived.mockResolvedValue({
                type: "text/plain",
                url: "shared note",
            });
            const bus = new EventBus();
            const handler = vi.fn();
            bus.addEventListener(Events.ROUTER_NAVIGATION, handler);
            const svc = new IntentService(bus);
            // listenForIntents is async; flush microtasks.
            await Promise.resolve();
            await Promise.resolve();
            expect(svc.intent).toBeInstanceOf(TextIntent);
            expect(handler).toHaveBeenCalledTimes(1);
            const ev = handler.mock.calls[0][0] as CustomEvent;
            expect(ev.detail.url).toBe("/intent/text");
        });

        it("ignores an intent with an unsupported MIME", async () => {
            mockSendIntent.checkSendIntentReceived.mockResolvedValue({
                type: "audio/mp3",
                url: "x",
            });
            const bus = new EventBus();
            const handler = vi.fn();
            bus.addEventListener(Events.ROUTER_NAVIGATION, handler);
            const svc = new IntentService(bus);
            await Promise.resolve();
            await Promise.resolve();
            expect(svc.intent).toBeUndefined();
            expect(handler).not.toHaveBeenCalled();
        });

        it("does nothing when no intent is pending", async () => {
            mockSendIntent.checkSendIntentReceived.mockResolvedValue(null);
            const bus = new EventBus();
            const handler = vi.fn();
            bus.addEventListener(Events.ROUTER_NAVIGATION, handler);
            const svc = new IntentService(bus);
            await Promise.resolve();
            await Promise.resolve();
            expect(svc.intent).toBeUndefined();
            expect(handler).not.toHaveBeenCalled();
        });
    });
});
