import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";
import type { BusTransport } from "../services/chat/chatBus";

export interface ChatSocketPlugin {
    open(options: {
        id: string;
        url: string;
        headers: Record<string, string>;
    }): Promise<void>;
    send(options: { id: string; text: string }): Promise<void>;
    close(options: { id: string }): Promise<void>;
    addListener(
        event: "chatSocketOpen",
        fn: (ev: { id: string }) => void
    ): Promise<PluginListenerHandle>;
    addListener(
        event: "chatSocketMessage",
        fn: (ev: { id: string; text: string }) => void
    ): Promise<PluginListenerHandle>;
    addListener(
        event: "chatSocketClose",
        fn: (ev: { id: string; code: number; reason: string }) => void
    ): Promise<PluginListenerHandle>;
}

/**
 * Native websocket (OkHttp): the Odoo bus needs the session Cookie and the
 * server's own Origin, which a WebView WebSocket cannot set.
 */
export const ChatSocket = registerPlugin<ChatSocketPlugin>("ChatSocket");

/** Live transports by socket id; the three shared listeners route into it. */
const routes = new Map<string, NativeTransport>();
let listenersReady: Promise<unknown> | null = null;

/** Registers the three plugin listeners once, for every transport. */
function ensureListeners(): Promise<unknown> {
    if (!listenersReady) {
        listenersReady = Promise.all([
            ChatSocket.addListener("chatSocketOpen", (ev) =>
                routes.get(ev.id)?.onOpen()
            ),
            ChatSocket.addListener("chatSocketMessage", (ev) =>
                routes.get(ev.id)?.onMessage(ev.text)
            ),
            ChatSocket.addListener("chatSocketClose", (ev) => {
                const t = routes.get(ev.id);
                if (!t) return;
                routes.delete(ev.id);
                t.onClose(ev.code, ev.reason);
            }),
        ]).catch((e) => {
            // A failed registration is retried by the next open().
            listenersReady = null;
            throw e;
        });
    }
    return listenersReady;
}

class NativeTransport implements BusTransport {
    onOpen: () => void = () => {};
    onMessage: (text: string) => void = () => {};
    onClose: (code: number, reason: string) => void = () => {};

    constructor(private id: string) {}

    open(url: string, headers: Record<string, string>): void {
        routes.set(this.id, this);
        ensureListeners()
            .then(() => {
                // Closed or replaced while the listeners registered.
                if (routes.get(this.id) !== this) return;
                return ChatSocket.open({ id: this.id, url, headers });
            })
            .catch((e) => {
                // A failed open is a close like any other: 1006, no frame.
                if (routes.get(this.id) !== this) return;
                routes.delete(this.id);
                this.onClose(1006, e instanceof Error ? e.message : String(e));
            });
    }

    send(text: string): void {
        ChatSocket.send({ id: this.id, text }).catch(() => {
            /* the socket's own close event reports the loss */
        });
    }

    /** Stops routing first, so no event of the closed socket reaches a successor. */
    close(): void {
        if (routes.get(this.id) === this) routes.delete(this.id);
        ChatSocket.close({ id: this.id }).catch(() => {});
    }
}

/** BusTransport over the native socket `id` (the account's configId). */
export function nativeTransport(id: string): BusTransport {
    return new NativeTransport(id);
}
