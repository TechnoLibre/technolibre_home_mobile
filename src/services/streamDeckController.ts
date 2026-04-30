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

/** Persistent Gallery shortcut — sits below the Note key (key 0) on a
 *  3-row × 5-col Stream Deck layout. Pressing it routes the mobile to
 *  /applications/gallery so the deck doubles as a remote thumbnail picker. */
const GALLERY_KEY = 5;
const GALLERY_TILE = { icon: "🖼️", label: "Galerie", bg: "#0e7490" };

/** While the gallery page is mounted on the mobile, the deck switches
 *  to a remote-control layout: thumbnail tiles fill the top of the
 *  deck, with the last three keys reserved for prev / next / back. */
interface GalleryImageRef {
    /** Remote URL the WebView (and the controller's <img>) can load. */
    url: string;
    /** Index in the full image list — sent to the mobile on press so
     *  it knows which image to open in fullscreen. */
    index: number;
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
    /** When the page became hidden — used to decide whether to do a
     *  full session restart on visible. Brief hides (<5 s, e.g. a
     *  notification briefly waking the screen) don't need it; a real
     *  sleep cycle does, because the reader's interrupt-IN endpoint
     *  consistently goes silent for ~10 s post-wake even though the
     *  USB bus stayed alive via the heartbeat. */
    private hiddenAt = 0;
    private static readonly RESTART_AFTER_HIDDEN_MS = 5000;
    /** Per-key timestamp of the last accepted press. The debounce
     *  budget is per-key, not shared, because the original 150 ms
     *  rule was put in place to protect against the IME-storm
     *  WebView crash triggered by mashing key 0 (Note → opens a
     *  textarea → keyboard show/hide cycles). Sharing the budget
     *  across keys 1-3 had a bad side-effect: pressing Note then
     *  immediately Audio dropped Audio because the Note press had
     *  just consumed the budget — the user had to press Audio
     *  twice. Per-key timestamps give the IME protection on key 0
     *  without penalising legitimate cross-key sequences. */
    private lastPressAt = new Map<number, number>();
    private static readonly NOTE_DEBOUNCE_MS = 150;
    /** True while a NoteComponent is mounted. Drives the paint of
     *  keys 1-3 (video/audio/location) and whether their presses
     *  fire the STREAMDECK_ADD_* events. */
    private noteActive = false;
    private noteActiveListener?: (e: any) => void;
    /** True while the gallery page is mounted on the mobile. The
     *  deck's layout flips to a thumb-grid + nav when this is on. */
    private galleryActive = false;
    private galleryImages: GalleryImageRef[] = [];
    private galleryPage = 0;
    private galleryActiveListener?: (e: any) => void;
    /** "Keep deck lit while phone is in sleep" — driven by the Options
     *  → Mise en veille checkbox via STREAMDECK_KEEP_AWAKE. When true,
     *  visibilitychange:hidden does not dim the deck, the LCDs keep
     *  their last image, and the wake-on-keypress native path (armed
     *  via StreamDeckPlugin.setWakeOnKeyPress) brings the phone back
     *  on. The flag is rehydrated from localStorage at boot so it
     *  survives an app restart without relying on the toggle's mount. */
    private keepDeckAwake = false;
    private keepAwakeListener?: (e: any) => void;

    constructor(
        private readonly eventBus: EventBusLike,
        private readonly noteService: NoteServiceLike,
    ) {
        // Register the note-page bus listener IMMEDIATELY, not after
        // the awaits in start(). The previous version installed it at
        // the end of start() — which on first boot can take 100+ ms
        // because it awaits listDecks and three plugin addListener
        // calls. If the user pressed the Note key (or otherwise
        // navigated to a note) before start() finished, the
        // STREAMDECK_NOTE_PAGE_ACTIVE event fired into a bus with no
        // listener, noteActive stayed false, and keys 1-3 never
        // painted. The user then had to navigate away and back to
        // re-fire the event, by which point start() had finished.
        if (this.eventBus.addEventListener) {
            this.noteActiveListener = (e: any) => {
                this.setNoteActive(!!e?.detail?.active).catch((err) =>
                    console.warn("[streamdeck] setNoteActive:", err),
                );
            };
            this.eventBus.addEventListener(
                Events.STREAMDECK_NOTE_PAGE_ACTIVE,
                this.noteActiveListener,
            );
            this.galleryActiveListener = (e: any) => {
                const active = !!e?.detail?.active;
                const images: GalleryImageRef[] = active
                    ? (e?.detail?.images ?? [])
                    : [];
                this.setGalleryActive(active, images).catch((err) =>
                    console.warn("[streamdeck] setGalleryActive:", err),
                );
            };
            this.eventBus.addEventListener(
                Events.STREAMDECK_GALLERY_PAGE_ACTIVE,
                this.galleryActiveListener,
            );
            this.keepAwakeListener = (e: any) => {
                const next = !!e?.detail?.enabled;
                if (next === this.keepDeckAwake) return;
                this.keepDeckAwake = next;
                // Apply immediately if the phone is currently hidden:
                // turning the flag on while dimmed restores brightness
                // (the deck is already idle, lighting it back up costs
                // ~50 ms of USB traffic), turning it off goes back to
                // dimmed so we don't drain power needlessly.
                if (this._isHidden()) {
                    for (const info of this.decks.values()) {
                        const pct = next ? this.getBrightness(info.deckId) : 0;
                        StreamDeckPlugin.setBrightness({
                            deckId: info.deckId, percent: pct,
                        }).catch((err) =>
                            console.warn("[streamdeck] keep-awake re-apply:", err),
                        );
                    }
                }
            };
            this.eventBus.addEventListener(
                Events.STREAMDECK_KEEP_AWAKE,
                this.keepAwakeListener,
            );
        }
        // Re-hydrate the user's "keep deck lit during sleep" choice
        // from localStorage. We can't await an event from the
        // checkbox component because by the time it mounts the
        // controller may already have processed a visibilitychange
        // (e.g. the phone briefly sleeps during the cold-start
        // hardware probe). Reading the storage key directly avoids
        // that race; the checkbox stays the single source of truth
        // for the *user-facing* state.
        try {
            if (typeof localStorage !== "undefined") {
                this.keepDeckAwake = localStorage.getItem(
                    "options.keepAwake.deckEnabled",
                ) === "true";
            }
        } catch { /* private browsing / SSR — ignore */ }
    }

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
        if (this.galleryActive) return;
        for (const info of this.decks.values()) {
            await this._paintNotePageKeys(info).catch((e) =>
                console.warn(`[streamdeck] note-page paint deckId=${info.deckId}:`, e),
            );
        }
    }

    /** Switch the deck into / out of gallery-remote mode. When `active`
     *  is true and `images` is non-empty, the entire deck flips to a
     *  thumbnail-grid layout: keys 0..N-4 paint the current page of
     *  thumbs, the last three keys are reserved for prev / next /
     *  back navigation. When deactivated, the deck repaints its
     *  default surface (Note + Gallery shortcut + note-page tiles). */
    async setGalleryActive(active: boolean, images: GalleryImageRef[] = []): Promise<void> {
        const wasActive = this.galleryActive;
        this.galleryActive = active;
        this.galleryImages = active ? images.slice() : [];
        this.galleryPage = 0;
        if (this.cameraStreaming || this._isHidden()) return;
        for (const info of this.decks.values()) {
            if (active) {
                await this._paintGallery(info).catch((e) =>
                    console.warn(`[streamdeck] gallery paint deckId=${info.deckId}:`, e),
                );
            } else if (wasActive) {
                await this._renderHome(info).catch((e) =>
                    console.warn(`[streamdeck] home repaint after gallery deckId=${info.deckId}:`, e),
                );
                await this._paintGalleryKey(info).catch((e) =>
                    console.warn(`[streamdeck] gallery shortcut deckId=${info.deckId}:`, e),
                );
                await this._paintNotePageKeys(info).catch((e) =>
                    console.warn(`[streamdeck] note keys after gallery deckId=${info.deckId}:`, e),
                );
            }
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
            if (this.galleryActive) {
                await this._paintGallery(info).catch((e) =>
                    console.warn(`[streamdeck] repaintAll gallery deckId=${info.deckId}:`, e),
                );
                continue;
            }
            await this._renderHome(info).catch((e) =>
                console.warn(`[streamdeck] repaintAll deckId=${info.deckId}:`, e),
            );
            await this._paintGalleryKey(info).catch((e) =>
                console.warn(`[streamdeck] repaintAll gallery key deckId=${info.deckId}:`, e),
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
            if (this.galleryActive) {
                await this._paintGallery(info).catch((e) =>
                    console.warn(`[streamdeck] gallery paint on attach deckId=${info.deckId}:`, e),
                );
                return;
            }
            await this._renderHome(info).catch((e) =>
                console.warn(`[streamdeck] paint deckId=${info.deckId}:`, e),
            );
            await this._paintGalleryKey(info).catch((e) =>
                console.warn(`[streamdeck] gallery key on attach deckId=${info.deckId}:`, e),
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
                // Per-key throttle ~6.6 presses/s — protects key 0
                // against the IME-storm WebView crash without blocking
                // legit cross-key sequences. See lastPressAt comment.
                const now = Date.now();
                const lastPress = this.lastPressAt.get(ev.key) ?? 0;
                if (now - lastPress < StreamDeckController.NOTE_DEBOUNCE_MS) return;
                if (this.galleryActive) {
                    this._handleGalleryKey(ev.deckId, ev.key, now);
                    return;
                }
                if (ev.key === 0) {
                    this.lastPressAt.set(ev.key, now);
                    const newId = this.noteService.getNewId();
                    this.eventBus.trigger(Events.ROUTER_NAVIGATION, {
                        url: `/note/${newId}`,
                    });
                    return;
                }
                if (ev.key === GALLERY_KEY) {
                    this.lastPressAt.set(ev.key, now);
                    this.eventBus.trigger(Events.ROUTER_NAVIGATION, {
                        url: "/applications/gallery",
                    });
                    return;
                }
                if (this.noteActive) {
                    const tile = NOTE_PAGE_TILES[ev.key];
                    if (!tile) return;
                    this.lastPressAt.set(ev.key, now);
                    this.eventBus.trigger(tile.event, { deckId: ev.deckId });
                }
            }),
        );

        // The PAGE_ACTIVE bus listener is registered eagerly in the
        // constructor — see the comment there.

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
                if (this.keepDeckAwake) {
                    // User opted in to "keep the deck lit during phone
                    // sleep" — skip the dim so the LCDs keep their
                    // last frame. The plugin's partial wake lock keeps
                    // USB enumerated; the wake-on-keypress native path
                    // (armed separately) takes care of bringing the
                    // phone back on a press.
                    return;
                }
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
                if (this.galleryActive) {
                    this._paintGallery(info).catch((e) =>
                        console.warn("[streamdeck] gallery repaint on visible:", e),
                    );
                    continue;
                }
                this._renderHome(info).catch((e) =>
                    console.warn("[streamdeck] repaint on visible:", e),
                );
                this._paintGalleryKey(info).catch((e) =>
                    console.warn("[streamdeck] gallery key repaint on visible:", e),
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
        if (this.galleryActiveListener && this.eventBus.removeEventListener) {
            this.eventBus.removeEventListener(
                Events.STREAMDECK_GALLERY_PAGE_ACTIVE,
                this.galleryActiveListener,
            );
            this.galleryActiveListener = undefined;
        }
        if (this.keepAwakeListener && this.eventBus.removeEventListener) {
            this.eventBus.removeEventListener(
                Events.STREAMDECK_KEEP_AWAKE,
                this.keepAwakeListener,
            );
            this.keepAwakeListener = undefined;
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

    /** Paint the persistent Gallery shortcut on key 5. Called whenever
     *  the home surface is repainted (deck attach, visibility:visible,
     *  exit-from-gallery). Skipped while a gallery remote is active —
     *  in that mode key 5 is owned by `_paintGallery`. */
    private async _paintGalleryKey(deck: DeckInfo): Promise<void> {
        const { w, h, format, rotation } = deck.keyImage;
        const blob = await this._renderTile(
            w, h, rotation ?? 0,
            GALLERY_TILE.icon, GALLERY_TILE.label, GALLERY_TILE.bg,
        );
        const bytes = await this._blobToBase64(blob);
        await StreamDeckPlugin.setKeyImage({
            deckId: deck.deckId,
            key: GALLERY_KEY,
            bytes,
            format: format === "jpeg" ? "jpeg" : "png",
        });
    }

    /** Paint the gallery-remote layout on `deck`: thumbs for the
     *  current page on the first N-3 keys, then prev / next / back
     *  on the last three. The thumb count per page adapts to the
     *  deck's geometry (Mk.2 = 12, XL = 29, Original v2 = 12, etc.). */
    private async _paintGallery(deck: DeckInfo): Promise<void> {
        const total = deck.keyCount;
        const thumbCount = Math.max(0, total - 3);
        if (thumbCount === 0) {
            // Tiny decks (Mini = 6 keys, Pedal = 3). Reserve last 2
            // keys for back / page-flip rather than crashing.
            return;
        }
        const start = this.galleryPage * thumbCount;
        const end = Math.min(start + thumbCount, this.galleryImages.length);
        for (let slot = 0; slot < thumbCount; slot++) {
            const key = slot;
            const img = this.galleryImages[start + slot];
            if (img) {
                await this._renderThumbnailKey(deck, key, img.url, start + slot)
                    .catch((e) =>
                        console.warn(`[streamdeck] thumb deckId=${deck.deckId} key=${key}:`, e),
                    );
            } else {
                await this._blankKey(deck, key).catch(() => { /* ignore */ });
            }
        }
        const prevKey = total - 3;
        const nextKey = total - 2;
        const backKey = total - 1;
        const pageMax = Math.max(0, Math.ceil(this.galleryImages.length / thumbCount) - 1);
        const prevAvail = this.galleryPage > 0;
        const nextAvail = this.galleryPage < pageMax;
        const dim = "#374151";
        await this._paintTile(
            deck, prevKey, "‹", "Préc.",
            prevAvail ? "#0e7490" : dim,
        );
        await this._paintTile(
            deck, nextKey, "›", "Suiv.",
            nextAvail ? "#0e7490" : dim,
        );
        await this._paintTile(deck, backKey, "←", "Retour", "#475569");
    }

    private async _paintTile(
        deck: DeckInfo,
        key: number,
        icon: string,
        label: string,
        bg: string,
    ): Promise<void> {
        const { w, h, format, rotation } = deck.keyImage;
        const blob = await this._renderTile(w, h, rotation ?? 0, icon, label, bg);
        const bytes = await this._blobToBase64(blob);
        await StreamDeckPlugin.setKeyImage({
            deckId: deck.deckId, key, bytes,
            format: format === "jpeg" ? "jpeg" : "png",
        });
    }

    /** Paint a single thumbnail key. Loads the image via <img>, draws
     *  a "cover" crop onto a deck-sized canvas, and ships JPEG bytes
     *  to the deck. Fallback on load failure: a placeholder tile with
     *  the image's gallery index. Errors during paint never bubble —
     *  one bad path should not freeze the whole grid. */
    private async _renderThumbnailKey(
        deck: DeckInfo,
        key: number,
        url: string,
        index: number,
    ): Promise<void> {
        const { w, h, format, rotation } = deck.keyImage;
        let blob: Blob;
        try {
            blob = await this._renderThumbnailTile(w, h, rotation ?? 0, url);
        } catch {
            blob = await this._renderTile(
                w, h, rotation ?? 0, "🖼️", `#${index + 1}`, "#1f2937",
            );
        }
        const bytes = await this._blobToBase64(blob);
        await StreamDeckPlugin.setKeyImage({
            deckId: deck.deckId, key, bytes,
            format: format === "jpeg" ? "jpeg" : "png",
        });
    }

    private async _renderThumbnailTile(
        w: number, h: number, rotationDeg: number, url: string,
    ): Promise<Blob> {
        const img = await this._loadImage(url);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas 2d context unavailable");
        if (rotationDeg !== 0) {
            ctx.translate(w / 2, h / 2);
            ctx.rotate((rotationDeg * Math.PI) / 180);
            ctx.translate(-w / 2, -h / 2);
        }
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, w, h);
        // "cover" crop — zoom the smaller axis, centre the larger.
        const srcRatio = img.naturalWidth / img.naturalHeight;
        const dstRatio = w / h;
        let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
        if (srcRatio > dstRatio) {
            sw = img.naturalHeight * dstRatio;
            sx = (img.naturalWidth - sw) / 2;
        } else {
            sh = img.naturalWidth / dstRatio;
            sy = (img.naturalHeight - sh) / 2;
        }
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
        return await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
                (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
                "image/jpeg",
                0.85,
            );
        });
    }

    private _loadImage(url: string): Promise<HTMLImageElement> {
        return new Promise((resolve, reject) => {
            const img = new Image();
            // Capacitor file:// URLs are same-origin to the WebView via
            // its custom scheme — no CORS attribute needed and toBlob()
            // does not taint the canvas. http(s) thumbs would need this
            // but the gallery only ships local note images today.
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`load failed: ${url}`));
            img.src = url;
        });
    }

    /** Handle a key press while the gallery remote is active. Thumb
     *  keys fire STREAMDECK_GALLERY_OPEN with the absolute index;
     *  the trailing prev / next / back keys flip pages locally or
     *  fire STREAMDECK_GALLERY_BACK to let the mobile decide whether
     *  to exit fullscreen or navigate back to /options. */
    private _handleGalleryKey(deckId: string, key: number, now: number): void {
        const deck = this.decks.get(deckId);
        if (!deck) return;
        const total = deck.keyCount;
        const thumbCount = Math.max(0, total - 3);
        const prevKey = total - 3;
        const nextKey = total - 2;
        const backKey = total - 1;
        if (key === backKey) {
            this.lastPressAt.set(key, now);
            this.eventBus.trigger(Events.STREAMDECK_GALLERY_BACK, {});
            return;
        }
        if (key === prevKey) {
            if (this.galleryPage > 0) {
                this.lastPressAt.set(key, now);
                this.galleryPage--;
                if (!this._isHidden()) {
                    this._paintGallery(deck).catch((e) =>
                        console.warn("[streamdeck] page prev paint:", e),
                    );
                }
            }
            return;
        }
        if (key === nextKey) {
            const pageMax = Math.max(
                0,
                Math.ceil(this.galleryImages.length / Math.max(1, thumbCount)) - 1,
            );
            if (this.galleryPage < pageMax) {
                this.lastPressAt.set(key, now);
                this.galleryPage++;
                if (!this._isHidden()) {
                    this._paintGallery(deck).catch((e) =>
                        console.warn("[streamdeck] page next paint:", e),
                    );
                }
            }
            return;
        }
        if (key < thumbCount) {
            const absoluteIdx = this.galleryPage * thumbCount + key;
            const img = this.galleryImages[absoluteIdx];
            if (!img) return;
            this.lastPressAt.set(key, now);
            this.eventBus.trigger(Events.STREAMDECK_GALLERY_OPEN, {
                index: img.index,
            });
        }
    }
}
