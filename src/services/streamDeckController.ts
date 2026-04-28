import type { PluginListenerHandle } from "@capacitor/core";
import {
    StreamDeckPlugin,
    DeckInfo,
} from "../plugins/streamDeckPlugin";
import { Events } from "../constants/events";

interface EventBusLike {
    trigger(name: string, payload: Record<string, unknown>): void;
}

interface NoteShape {
    title?: string;
    tags?: string[];
    entries?: unknown[];
}

interface NoteServiceLike {
    getNewId(): string;
    getMatch(noteId: string): Promise<NoteShape>;
}

/**
 * Minimal Stream Deck controller — wires the deck's first key to the
 * "create new note" flow. When a deck (re)connects, key 0 is repainted
 * with a "📝 Note" tile; pressing it triggers the same router event the
 * Home and NoteList components use.
 *
 * Multi-deck: every connected deck gets the same treatment in parallel.
 * The image renderer uses the deck's spec.keyImage.{w,h,format} so it
 * works on every model (72/80/96/120 px keys, JPEG or PNG-for-BMP).
 */
export class StreamDeckController {
    private decks = new Map<string, DeckInfo>();
    private listeners: PluginListenerHandle[] = [];
    /** When true, the home tile and key-0 navigation are suspended so the
     * camera streamer (or any future taker-over) owns the deck surface. */
    private cameraStreaming = false;
    /** Last user-set brightness per deck. Stream Deck firmware doesn't
     *  expose getBrightness, so we cache the value at the moment we
     *  send setBrightness — used to restore the deck's pre-sleep
     *  brightness on visibility:visible after we dim to 0 on hidden. */
    private lastBrightness = new Map<string, number>();
    private static readonly DEFAULT_BRIGHTNESS = 50;
    /** Debounce timestamp for the Note key. Rapid mash-fires used to
     *  spawn unbounded route transitions and crash the app. */
    private lastNotePressAt = 0;
    private static readonly NOTE_DEBOUNCE_MS = 400;

    constructor(
        private readonly eventBus: EventBusLike,
        private readonly noteService: NoteServiceLike,
    ) {}

    setCameraStreaming(active: boolean): void {
        this.cameraStreaming = active;
    }

    /** Set deck brightness, remembering the value so we can restore it
     *  after sleep. Callers that adjust brightness should use this
     *  wrapper rather than StreamDeckPlugin.setBrightness directly,
     *  otherwise their value is lost across the next sleep cycle. */
    async setBrightness(deckId: string, percent: number): Promise<void> {
        const clamped = Math.max(0, Math.min(100, Math.round(percent)));
        this.lastBrightness.set(deckId, clamped);
        await StreamDeckPlugin.setBrightness({ deckId, percent: clamped });
    }

    getBrightness(deckId: string): number {
        return this.lastBrightness.get(deckId)
            ?? StreamDeckController.DEFAULT_BRIGHTNESS;
    }

    /** Repaint the home tile on every known deck. Used by the camera
     *  streamer when it stops, so the user lands back on "Note". */
    async repaintAll(): Promise<void> {
        if (this.cameraStreaming) return;
        if (this._isHidden()) return;
        for (const info of this.decks.values()) {
            await this._renderHome(info).catch((e) =>
                console.warn(`[streamdeck] repaintAll deckId=${info.deckId}:`, e),
            );
        }
    }

    async start(): Promise<void> {
        // Repaint the home tile on every deck (re)connection — but only
        // when the app is actually visible. Otherwise we'd flicker the
        // deck during phone-sleep micro-wakeups: USB OTG briefly
        // re-enumerates the device, the hotplug receiver fires
        // deckConnected, and an unconditional paint flashes "Note" on
        // the LCD before USB suspends again.
        const repaintIfVisible = async (info: DeckInfo) => {
            if (this.cameraStreaming) return;
            if (this._isHidden()) return;
            await this._renderHome(info).catch((e) =>
                console.warn(`[streamdeck] paint deckId=${info.deckId}:`, e),
            );
        };

        // Pick up decks already connected at boot time.
        try {
            const r = await StreamDeckPlugin.listDecks();
            for (const d of r.decks) {
                this.decks.set(d.deckId, d);
                await repaintIfVisible(d);
            }
        } catch (e) {
            console.warn("[streamdeck] listDecks at boot failed:", e);
        }

        this.listeners.push(
            await StreamDeckPlugin.addListener("deckConnected", async (ev) => {
                const info = ev.info ?? (await StreamDeckPlugin.getDeckInfo({
                    deckId: ev.deckId,
                }));
                this.decks.set(info.deckId, info);
                await repaintIfVisible(info);
            }),
        );

        this.listeners.push(
            await StreamDeckPlugin.addListener("deckDisconnected", (ev) => {
                this.decks.delete(ev.deckId);
            }),
        );

        this.listeners.push(
            await StreamDeckPlugin.addListener("keyChanged", async (ev) => {
                if (!ev.pressed) return;
                // While the camera streamer owns the deck, the streamer
                // itself listens to keyChanged to stop. Suppress home
                // navigation so the press doesn't double-trigger.
                if (this.cameraStreaming) return;
                if (ev.key !== 0) return;

                // Debounce — rapid mash on the deck used to fire dozens
                // of route transitions in flight and crash the app.
                const now = Date.now();
                if (now - this.lastNotePressAt < StreamDeckController.NOTE_DEBOUNCE_MS) return;
                this.lastNotePressAt = now;

                // If we're already sitting on a blank note, stay put —
                // the user intent for "press Note again" is "give me a
                // fresh empty note" and the current one already qualifies.
                // Pressing it on a note that has content does spawn a
                // new note (that's the way to start a second one without
                // walking back to the home screen).
                if (await this._currentNoteIsBlank()) return;

                const newId = this.noteService.getNewId();
                this.eventBus.trigger(Events.ROUTER_NAVIGATION, {
                    url: `/note/${newId}`,
                });
            }),
        );

        // Dim every deck to 0 while the page is hidden (phone locked /
        // app backgrounded). setBrightness(0) hides the LCDs without
        // touching the HID interface — earlier we used reset() here
        // and the reader thread's interrupt-IN pipe was left in a
        // state where post-wake key presses didn't surface, requiring
        // a manual session restart. Brightness is a feature-report
        // write that's safe to issue concurrently with the reader.
        // On the way back, restore the user's brightness and repaint
        // the home tile.
        document.addEventListener("visibilitychange", () => {
            if (this._isHidden()) {
                for (const info of this.decks.values()) {
                    StreamDeckPlugin.setBrightness({
                        deckId: info.deckId, percent: 0,
                    }).catch((e) =>
                        console.warn("[streamdeck] dim on hidden:", e),
                    );
                }
                return;
            }
            for (const info of this.decks.values()) {
                StreamDeckPlugin.setBrightness({
                    deckId: info.deckId,
                    percent: this.getBrightness(info.deckId),
                }).catch((e) =>
                    console.warn("[streamdeck] restore brightness:", e),
                );
                if (this.cameraStreaming) continue;
                this._renderHome(info).catch((e) =>
                    console.warn("[streamdeck] repaint on visible:", e),
                );
            }
        });
    }

    private async _currentNoteIsBlank(): Promise<boolean> {
        if (typeof window === "undefined") return false;
        const m = window.location.pathname.match(/^\/note\/([^/?#]+)/);
        if (!m) return false;
        try {
            const note = await this.noteService.getMatch(m[1]);
            const hasTitle = (note.title ?? "").trim().length > 0;
            const hasTags = Array.isArray(note.tags) && note.tags.length > 0;
            const hasEntries = Array.isArray(note.entries) && note.entries.length > 0;
            return !(hasTitle || hasTags || hasEntries);
        } catch {
            // Note id in URL but no DB row yet — that's a freshly-spawned
            // note the user hasn't typed into. Treat as blank.
            return true;
        }
    }

    private _isHidden(): boolean {
        // Treat both 'hidden' and 'prerender' as "skip paint".
        return typeof document !== "undefined"
            && document.visibilityState !== undefined
            && document.visibilityState !== "visible";
    }

    async stop(): Promise<void> {
        for (const h of this.listeners) {
            try { await h.remove(); } catch { /* ignore */ }
        }
        this.listeners = [];
    }

    private async _renderHome(deck: DeckInfo): Promise<void> {
        const { w, h, format, rotation } = deck.keyImage;
        const blob = await this._renderTile(w, h, rotation ?? 0, "📝", "Note", "#1e3a8a");
        const bytes = await this._blobToBase64(blob);
        await StreamDeckPlugin.setKeyImage({
            deckId: deck.deckId,
            key: 0,
            bytes,
            format: format === "jpeg" ? "jpeg" : "png",
        });
    }

    private async _renderTile(
        w: number,
        h: number,
        rotationDeg: number,
        icon: string,
        label: string,
        bg: string,
    ): Promise<Blob> {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas 2d context unavailable");

        // Some Stream Deck models (XL, MK.2, Original v2…) have their LCD
        // mounted upside-down. Rotate the entire context BEFORE drawing so
        // the JPEG bytes we ship out come pre-flipped — the user sees it
        // upright when looking at the deck normally.
        if (rotationDeg !== 0) {
            ctx.translate(w / 2, h / 2);
            ctx.rotate((rotationDeg * Math.PI) / 180);
            ctx.translate(-w / 2, -h / 2);
        }

        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);

        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        // Icon (emoji): big, top half.
        ctx.font = `${Math.floor(h * 0.42)}px sans-serif`;
        ctx.fillText(icon, w / 2, h * 0.4);

        // Label: smaller, bottom quarter.
        ctx.font = `bold ${Math.floor(h * 0.18)}px sans-serif`;
        ctx.fillText(label, w / 2, h * 0.78);

        return await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
                (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
                "image/jpeg",
                0.9,
            );
        });
    }

    private async _blobToBase64(blob: Blob): Promise<string> {
        const buf = await blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }
}
