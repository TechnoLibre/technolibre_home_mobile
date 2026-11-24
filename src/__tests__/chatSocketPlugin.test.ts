import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockApi, handlers } = vi.hoisted(() => {
    const handlers: Record<string, (ev: any) => void> = {};
    return {
        handlers,
        mockApi: {
            open: vi.fn(),
            send: vi.fn(),
            close: vi.fn(),
            addListener: vi.fn(async (name: string, fn: (ev: any) => void) => {
                handlers[name] = fn;
                return { remove: async () => {} };
            }),
        },
    };
});

vi.mock("@capacitor/core", () => ({
    registerPlugin: () => mockApi,
}));

import { nativeTransport } from "../plugins/chatSocketPlugin";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("nativeTransport", () => {
    beforeEach(() => {
        mockApi.open.mockReset().mockResolvedValue(undefined);
        mockApi.send.mockReset().mockResolvedValue(undefined);
        mockApi.close.mockReset().mockResolvedValue(undefined);
    });

    it("opens, sends and closes through the plugin with its id", async () => {
        const t = nativeTransport("a");
        t.open("wss://x.example/websocket", { Origin: "https://x.example" });
        await flush();
        expect(mockApi.open).toHaveBeenCalledWith({
            id: "a",
            url: "wss://x.example/websocket",
            headers: { Origin: "https://x.example" },
        });
        t.send("hi");
        expect(mockApi.send).toHaveBeenCalledWith({ id: "a", text: "hi" });
        t.close();
        expect(mockApi.close).toHaveBeenCalledWith({ id: "a" });
    });

    it("routes events by id, never to another transport", async () => {
        const a = nativeTransport("a");
        const b = nativeTransport("b");
        const aOpen = vi.fn(), aMsg = vi.fn(), bOpen = vi.fn(), bMsg = vi.fn();
        a.onOpen = aOpen; a.onMessage = aMsg;
        b.onOpen = bOpen; b.onMessage = bMsg;
        a.open("wss://x/w", {});
        b.open("wss://y/w", {});
        await flush();
        handlers.chatSocketOpen({ id: "a" });
        handlers.chatSocketMessage({ id: "a", text: "one" });
        handlers.chatSocketMessage({ id: "b", text: "two" });
        expect(aOpen).toHaveBeenCalledTimes(1);
        expect(bOpen).not.toHaveBeenCalled();
        expect(aMsg).toHaveBeenCalledWith("one");
        expect(bMsg).toHaveBeenCalledWith("two");
        expect(aMsg).toHaveBeenCalledTimes(1);
    });

    it("close event carries code and reason, then the route is gone", async () => {
        const t = nativeTransport("c");
        const onClose = vi.fn(), onMessage = vi.fn();
        t.onClose = onClose; t.onMessage = onMessage;
        t.open("wss://x/w", {});
        await flush();
        handlers.chatSocketClose({ id: "c", code: 4001, reason: "session" });
        expect(onClose).toHaveBeenCalledWith(4001, "session");
        handlers.chatSocketMessage({ id: "c", text: "late" });
        expect(onMessage).not.toHaveBeenCalled();
    });

    it("a closed transport receives nothing more", async () => {
        const t = nativeTransport("d");
        const onClose = vi.fn();
        t.onClose = onClose;
        t.open("wss://x/w", {});
        await flush();
        t.close();
        handlers.chatSocketClose({ id: "d", code: 1000, reason: "" });
        expect(onClose).not.toHaveBeenCalled();
    });

    it("a failed open reports close 1006 with the message", async () => {
        mockApi.open.mockRejectedValue(new Error("boom"));
        const t = nativeTransport("e");
        const onClose = vi.fn();
        t.onClose = onClose;
        t.open("wss://x/w", {});
        await flush();
        expect(onClose).toHaveBeenCalledWith(1006, "boom");
    });

    it("close before the listeners are ready skips the native open", async () => {
        const t = nativeTransport("f");
        t.open("wss://x/w", {});
        t.close();
        await flush();
        expect(mockApi.open).not.toHaveBeenCalled();
    });

    it("a rejected listener registration is retried by the next open", async () => {
        vi.resetModules();
        mockApi.addListener.mockRejectedValueOnce(new Error("no bridge"));
        const fresh = await import("../plugins/chatSocketPlugin");
        const t1 = fresh.nativeTransport("g");
        const onClose = vi.fn();
        t1.onClose = onClose;
        t1.open("wss://x/w", {});
        await flush();
        expect(onClose).toHaveBeenCalledWith(1006, "no bridge");
        const t2 = fresh.nativeTransport("g");
        t2.open("wss://x/w", {});
        await flush();
        expect(mockApi.open).toHaveBeenCalledTimes(1);
    });
});
