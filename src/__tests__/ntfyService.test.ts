import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NtfyService } from "../services/ntfyService";

// EventSource isn't part of node — stub a tiny in-memory version.
class FakeEventSource {
    public static instances: FakeEventSource[] = [];
    public url: string;
    public onerror: ((e?: any) => void) | null = null;
    private listeners = new Map<string, ((e: MessageEvent) => void)[]>();
    public closed = false;
    constructor(url: string) {
        this.url = url;
        FakeEventSource.instances.push(this);
    }
    addEventListener(name: string, fn: (e: MessageEvent) => void) {
        const arr = this.listeners.get(name) ?? [];
        arr.push(fn);
        this.listeners.set(name, arr);
    }
    emit(name: string, data: string) {
        for (const fn of this.listeners.get(name) ?? []) {
            fn({ data } as MessageEvent);
        }
    }
    close() { this.closed = true; }
}

function streamFromLines(lines: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const l of lines) controller.enqueue(enc.encode(l));
            controller.close();
        },
    });
}

describe("NtfyService", () => {
    beforeEach(() => {
        FakeEventSource.instances.length = 0;
        vi.stubGlobal("EventSource", FakeEventSource as any);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    describe("connect", () => {
        it("is a no-op when url or topic is empty", () => {
            const svc = new NtfyService();
            const cb = vi.fn();
            svc.connect("", "topic", cb);
            svc.connect("https://x", "", cb);
            expect(svc.isConnected).toBe(false);
            expect(FakeEventSource.instances.length).toBe(0);
            expect(cb).not.toHaveBeenCalled();
        });

        it("opens an EventSource at <url>/<topic>/sse without a token", () => {
            const svc = new NtfyService();
            svc.connect("https://ntfy.example.com/", "my-topic", () => {});
            expect(FakeEventSource.instances).toHaveLength(1);
            expect(FakeEventSource.instances[0].url)
                .toBe("https://ntfy.example.com/my-topic/sse");
            expect(svc.isConnected).toBe(true);
        });

        it("forwards data.title from EventSource messages", () => {
            const cb = vi.fn();
            const svc = new NtfyService();
            svc.connect("https://x", "t", cb);
            const es = FakeEventSource.instances[0];
            es.emit("message", JSON.stringify({ title: "Hello" }));
            expect(cb).toHaveBeenCalledWith("Hello");
        });

        it("falls back to data.message when title is absent", () => {
            const cb = vi.fn();
            const svc = new NtfyService();
            svc.connect("https://x", "t", cb);
            FakeEventSource.instances[0].emit(
                "message", JSON.stringify({ message: "Hi" }),
            );
            expect(cb).toHaveBeenCalledWith("Hi");
        });

        it("uses a default label when payload is malformed", () => {
            const cb = vi.fn();
            const svc = new NtfyService();
            svc.connect("https://x", "t", cb);
            FakeEventSource.instances[0].emit("message", "not json");
            expect(cb).toHaveBeenCalledWith("Notification Odoo");
        });

        it("closes the previous EventSource on reconnect", () => {
            const svc = new NtfyService();
            svc.connect("https://x", "a", () => {});
            const first = FakeEventSource.instances[0];
            svc.connect("https://x", "b", () => {});
            expect(first.closed).toBe(true);
            expect(FakeEventSource.instances).toHaveLength(2);
            expect(FakeEventSource.instances[1].url).toContain("/b/sse");
        });
    });

    describe("connect with token (fetch path)", () => {
        it("sends a Bearer header and consumes SSE data: lines", async () => {
            const cb = vi.fn();
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                body: streamFromLines([
                    'data: {"title":"first"}\n',
                    'data: {"title":"second"}\n',
                ]),
            });
            vi.stubGlobal("fetch", fetchMock);
            const svc = new NtfyService();
            svc.connect("https://x", "t", cb, "secret-token");
            // Microtask flush — fetch + reader loop are async.
            for (let i = 0; i < 20; i++) await Promise.resolve();
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe("https://x/t/sse");
            expect((init as any).headers.Authorization).toBe(
                "Bearer secret-token",
            );
            expect(cb).toHaveBeenNthCalledWith(1, "first");
            expect(cb).toHaveBeenNthCalledWith(2, "second");
        });

        it("flips isConnected to false on a non-2xx response", async () => {
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
                ok: false, body: null,
            }));
            const svc = new NtfyService();
            svc.connect("https://x", "t", () => {}, "tok");
            for (let i = 0; i < 5; i++) await Promise.resolve();
            expect(svc.isConnected).toBe(false);
        });

        it("skips malformed data: lines without throwing", async () => {
            const cb = vi.fn();
            vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
                ok: true,
                body: streamFromLines([
                    'data: not-json\n',
                    'data: {"title":"ok"}\n',
                ]),
            }));
            const svc = new NtfyService();
            svc.connect("https://x", "t", cb, "tok");
            for (let i = 0; i < 20; i++) await Promise.resolve();
            expect(cb).toHaveBeenCalledTimes(1);
            expect(cb).toHaveBeenCalledWith("ok");
        });
    });

    describe("disconnect", () => {
        it("closes the EventSource and resets isConnected", () => {
            const svc = new NtfyService();
            svc.connect("https://x", "t", () => {});
            const es = FakeEventSource.instances[0];
            svc.disconnect();
            expect(es.closed).toBe(true);
            expect(svc.isConnected).toBe(false);
        });

        it("is safe to call when never connected", () => {
            const svc = new NtfyService();
            expect(() => svc.disconnect()).not.toThrow();
            expect(svc.isConnected).toBe(false);
        });
    });
});
