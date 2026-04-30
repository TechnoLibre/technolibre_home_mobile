import type { PluginListenerHandle } from "@capacitor/core";
import {
    StreamDeckPlugin,
    DeckInfo,
} from "../plugins/streamDeckPlugin";
import { Events } from "../constants/events";

interface EventBusLike {
    trigger(name: string, payload: Record<string, unknown>): void;
    addEventListener?(name: string, fn: (e: any) => void): void;
    removeEventListener?(name: string, fn: (e: any) => void): void;
}

interface NoteServiceLike {
    getNewId(): string;
}

/** Per-key tile config: emoji icon + label + bg + which event to fire on
 *  press. Key 0 is always painted; keys 1-3 only when a note page is
 *  active (`noteActive=true`). Indices match deck key positions. */
const NOTE_PAGE_TILES: Record<number, { icon: string; label: string; bg: string; event: string }> = {
    1: { icon: "🎥", label: "Vidéo", bg: "#7c3aed", event: Events.STREAMDECK_ADD_VIDEO },
    2: { icon: "🎤", label: "Audio", bg: "#16a34a", event: Events.STREAMDECK_ADD_AUDIO },
    3: { icon: "📍", label: "Lieu",  bg: "#ea580c", event: Events.STREAMDECK_ADD_LOCATION },
};
const NOTE_PAGE_KEYS = Object.keys(NOTE_PAGE_TILES).map(Number);

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
    /** When the page became hidden — used to decide whether to do a
     *  full session restart on visible. Brief hides (<5 s, e.g. a
     *  notification briefly waking the screen) don't need it; a real
     *  sleep cycle does, because the reader's interrupt-IN endpoint
     *  consistently goes silent for ~10 s post-wake even though the
     *  USB bus stayed alive via the heartbeat. */
    private hiddenAt = 0;
    private static readonly RESTART_AFTER_HIDDEN_MS = 5000;
    /** Minimum ms between Note-key navigations. Tuned to stay below
     *  the ~8 keyboard-show/hide cycles per second threshold that
     *  reproduced a SIGSEGV in HWUI's RenderThread on Pixel 6, while
     *  still letting an intentional 100–150 ms double-tap register
     *  both presses. 250 ms felt laggy on a deliberate two-tap;
     *  150 ms passes both clicks through and still caps mash at
     *  ~6.6/s — well under the crash threshold. */
    private lastNotePressAt = 0;
    private static readonly NOTE_DEBOUNCE_MS = 150;
    /** True while a NoteComponent is mounted. Drives the paint of
     *  keys 1-3 (video/audio/location) and whether their presses
     *  fire the STREAMDECK_ADD_* events. */
    private noteActive = false;
    private noteActiveListener?: (e: any) => void;

    constructor(
        private readonly eventBus: EventBusLike,
        private readonly noteService: NoteServiceLike,
    ) {}

    setCameraStreaming(active: boolean): void {
        this.cameraStreaming = active;
    }

    /** Toggle the note-page action keys (video/audio/location). When
     *  active, keys 1-3 get their tiles painted on every connected
     *  deck; when inactive, they are blanked. Camera-streaming mode
     *  takes precedence — paints are skipped while it owns the deck. */
    async setNoteActive(active: boolean): Promise<void> {
        if (this.noteActive === active) return;
        this.noteActive = active;
        if (this.cameraStreaming || this._isHidden()) return;
        for (const info of this.decks.values()) {
            await this._paintNotePageKeys(info).catch((e) =>
                console.warn(`[streamdeck] note-page paint deckId=${info.deckId}:`, e),
            );
        }
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

    /** Repaint the home tile (and the note-page keys when a note is
     *  active) on every known deck. Used by the camera streamer when
     *  it stops, so the user lands back on the right surface. */
    async repaintAll(): Promise<void> {
        if (this.cameraStreaming) return;
        if (this._isHidden()) return;
        for (const info of this.decks.values()) {
            await this._renderHome(info).catch((e) =>
                console.warn(`[streamdeck] repaintAll deckId=${info.deckId}:`, e),
            );
            await this._paintNotePageKeys(info).catch((e) =>
                console.warn(`[streamdeck] repaintAll note keys deckId=${info.deckId}:`, e),
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
            if (this._isHidden()) return;
            // Re-applied unconditionally on every (re)connect so
            // restartSessions on visibility:visible picks up the
            // user's pre-sleep brightness — the firmware resets to
            // its default on session reopen.
            StreamDeckPlugin.setBrightness({
                deckId: info.deckId,
                percent: this.getBrightness(info.deckId),
            }).catch((e) =>
                console.warn(`[streamdeck] brightness on attach deckId=${info.deckId}:`, e),
            );
            if (this.cameraStreaming) return;
            await this._renderHome(info).catch((e) =>
                console.warn(`[streamdeck] paint deckId=${info.deckId}:`, e),
            );
            await this._paintNotePageKeys(info).catch((e) =>
                console.warn(`[streamdeck] note-page paint on attach deckId=${info.deckId}:`, e),
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
            await StreamDeckPlugin.addListener("keyChanged", (ev) => {
                if (!ev.pressed) return;
                // While the camera streamer owns the deck, the streamer
                // itself listens to keyChanged to stop. Suppress every
                // surface key so the press doesn't double-trigger.
                if (this.cameraStreaming) return;
                // Throttle to ~6.6 presses/s — protects against the
                // IME-storm WebView crash described above. The same
                // budget is shared across keys 0-3 since the crash
                // trigger is keyboard-show/hide cycles, not per-key.
                const now = Date.now();
                if (now - this.lastNotePressAt < StreamDeckController.NOTE_DEBOUNCE_MS) return;
                if (ev.key === 0) {
                    this.lastNotePressAt = now;
                    const newId = this.noteService.getNewId();
                    this.eventBus.trigger(Events.ROUTER_NAVIGATION, {
                        url: `/note/${newId}`,
                    });
                    return;
                }
                if (this.noteActive) {
                    const tile = NOTE_PAGE_TILES[ev.key];
                    if (!tile) return;
                    this.lastNotePressAt = now;
                    this.eventBus.trigger(tile.event, { deckId: ev.deckId });
                }
            }),
        );

        // Listen for note-page lifecycle events from NoteComponent. The
        // component fires on mount with active=true and on willDestroy
        // with active=false; we paint or blank keys 1-3 accordingly.
        if (this.eventBus.addEventListener) {
            this.noteActiveListener = (e: any) => {
                this.setNoteActive(!!e.detail?.active).catch((err) =>
                    console.warn("[streamdeck] setNoteActive:", err),
                );
            };
            this.eventBus.addEventListener(
                Events.STREAMDECK_NOTE_PAGE_ACTIVE,
                this.noteActiveListener,
            );
        }

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
                this.hiddenAt = Date.now();
                for (const info of this.decks.values()) {
                    StreamDeckPlugin.setBrightness({
                        deckId: info.deckId, percent: 0,
                    }).catch((e) =>
                        console.warn("[streamdeck] dim on hidden:", e),
                    );
                }
                return;
            }
            const hiddenFor = this.hiddenAt > 0 ? Date.now() - this.hiddenAt : 0;
            this.hiddenAt = 0;
            // After a real sleep cycle (>5 s), the deck's reader pipe
            // can sit silent for ~10 s post-wake even with the
            // heartbeat keeping the bus active. A full session
            // restart re-creates the reader/writer threads from
            // scratch and the next press lands instantly. The
            // deckConnected listener above will repaint Note for each
            // re-attached deck, so we don't repaint here. Brightness
            // is reset to the firmware default on restart, so the
            // restore call on the post-restart attach path picks up
            // the user's value via the cache.
            if (hiddenFor > StreamDeckController.RESTART_AFTER_HIDDEN_MS) {
                StreamDeckPlugin.restartSessions().catch((e) =>
                    console.warn("[streamdeck] restartSessions on visible:", e),
                );
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
                this._paintNotePageKeys(info).catch((e) =>
                    console.warn("[streamdeck] note-page repaint on visible:", e),
                );
            }
        });
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
        if (this.noteActiveListener && this.eventBus.removeEventListener) {
            this.eventBus.removeEventListener(
                Events.STREAMDECK_NOTE_PAGE_ACTIVE,
                this.noteActiveListener,
            );
            this.noteActiveListener = undefined;
        }
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

    /** Paint or blank keys 1-3 according to noteActive. Called on
     *  setNoteActive, on (re)connect, on visibility:visible, and from
     *  repaintAll after the camera streamer stops. */
    private async _paintNotePageKeys(deck: DeckInfo): Promise<void> {
        const { w, h, format, rotation } = deck.keyImage;
        const fmt = format === "jpeg" ? "jpeg" : "png";
        for (const keyStr of Object.keys(NOTE_PAGE_TILES)) {
            const key = Number(keyStr);
            if (this.noteActive) {
                const t = NOTE_PAGE_TILES[key];
                const blob = await this._renderTile(w, h, rotation ?? 0, t.icon, t.label, t.bg);
                const bytes = await this._blobToBase64(blob);
                await StreamDeckPlugin.setKeyImage({
                    deckId: deck.deckId, key, bytes, format: fmt,
                });
            } else {
                await this._blankKey(deck, key);
            }
        }
    }

    private async _blankKey(deck: DeckInfo, key: number): Promise<void> {
        const { w, h, format, rotation } = deck.keyImage;
        const blob = await this._renderTile(w, h, rotation ?? 0, "", "", "#000000");
        const bytes = await this._blobToBase64(blob);
        await StreamDeckPlugin.setKeyImage({
            deckId: deck.deckId,
            key,
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
