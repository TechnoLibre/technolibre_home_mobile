import type { PluginListenerHandle } from "@capacitor/core";
import { Camera } from "@capacitor/camera";
import { StreamDeckPlugin, DeckInfo } from "../plugins/streamDeckPlugin";
import type { StreamDeckController } from "./streamDeckController";

interface ListenerLike {
    (active: boolean): void;
}

interface DeckCanvasCache {
    composite: HTMLCanvasElement;
    cctx: CanvasRenderingContext2D;
    tile: HTMLCanvasElement;
    tctx: CanvasRenderingContext2D;
    canvasW: number;
    canvasH: number;
    kw: number;
    kh: number;
}

/**
 * Pumps the rear-facing camera onto every connected Stream Deck. While
 * active, the controller's "Note" tile is suppressed so the home key
 * doesn't fight the streamer for key 0. Pressing any deck key while
 * streaming also stops it — same UX as toggling the option off.
 *
 * Pipeline per tick:
 *   getUserMedia → <video> → composite canvas (cached per deck) →
 *   per-key tile crop → JPEG via toDataURL → setKeyImage.
 *
 * Performance notes:
 *   - canvas.toDataURL is synchronous; toBlob would be ~100–500 ms per
 *     call inside Android WebView (encoder thread context switch).
 *     With 32 tiles per deck × 2 decks that single change collapses
 *     a 20-second tick into ~1 second.
 *   - Composite + tile canvases are pooled per deckId. Per-tick
 *     allocations would cost ~1 MB and force GC pauses.
 *   - WriterQueue on the Java side coalesces by (deck, key) so even
 *     a slow USB drain can't queue-bomb us — only the latest frame
 *     per key actually gets written.
 */
export class StreamDeckCameraStreamer {
    private static readonly TICK_MS = 200; // 5 fps target — actual rate depends on encode + USB drain
    private static readonly JPEG_QUALITY = 0.55;

    private active = false;
    private stream: MediaStream | null = null;
    private video: HTMLVideoElement | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private listeners: PluginListenerHandle[] = [];
    private decks = new Map<string, DeckInfo>();
    private deckCache = new Map<string, DeckCanvasCache>();
    private inFlight = false;
    private listenersOut = new Set<ListenerLike>();
    private lastTickStart = 0;
    private tickCount = 0;

    constructor(private readonly controller: StreamDeckController) {}

    isActive(): boolean { return this.active; }

    onActiveChange(cb: ListenerLike): () => void {
        this.listenersOut.add(cb);
        return () => this.listenersOut.delete(cb);
    }

    private notifyActive(): void {
        for (const cb of this.listenersOut) {
            try { cb(this.active); } catch (e) { console.warn("[camera-streamer] listener:", e); }
        }
    }

    async start(): Promise<void> {
        if (this.active) return;

        // Request OS-level CAMERA permission first; getUserMedia inside
        // the WebView will silently fail without it on Android.
        const perm = await Camera.requestPermissions({ permissions: ["camera"] });
        if (perm.camera !== "granted") {
            throw new Error(`camera_permission_${perm.camera}`);
        }

        const decksReply = await StreamDeckPlugin.listDecks();
        if (decksReply.decks.length === 0) {
            throw new Error("no_decks_connected");
        }
        this.decks.clear();
        for (const d of decksReply.decks) this.decks.set(d.deckId, d);

        this.stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: "environment",
                width: { ideal: 1280 },
                height: { ideal: 720 },
            },
            audio: false,
        });

        const v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.autoplay = true;
        v.srcObject = this.stream;
        // Keep the element off-screen but attached so the WebView keeps
        // decoding frames even when no <video> is in the visible DOM.
        v.style.position = "fixed";
        v.style.left = "-9999px";
        v.style.top = "-9999px";
        v.style.width = "1px";
        v.style.height = "1px";
        document.body.appendChild(v);
        await v.play().catch(() => {/* autoplay may resolve via play() retry below */});
        this.video = v;

        this.controller.setCameraStreaming(true);
        this.active = true;
        this.notifyActive();

        this.timer = setInterval(() => {
            try { this.tick(); }
            catch (e) { console.warn("[camera-streamer] tick:", e); }
        }, StreamDeckCameraStreamer.TICK_MS);
        this.tickCount = 0;
        this.lastTickStart = 0;

        // Track decks attaching/detaching while we stream so we keep
        // every connected surface in sync.
        this.listeners.push(
            await StreamDeckPlugin.addListener("deckConnected", async (ev) => {
                try {
                    const info = ev.info ?? (await StreamDeckPlugin.getDeckInfo({ deckId: ev.deckId }));
                    this.decks.set(info.deckId, info);
                } catch (e) {
                    console.warn("[camera-streamer] deckConnected:", e);
                }
            }),
        );
        this.listeners.push(
            await StreamDeckPlugin.addListener("deckDisconnected", (ev) => {
                this.decks.delete(ev.deckId);
                this.deckCache.delete(ev.deckId);
            }),
        );
        // Pressing any key while streaming behaves as a stop — saves
        // the user from walking back to the phone.
        this.listeners.push(
            await StreamDeckPlugin.addListener("keyChanged", (ev) => {
                if (!ev.pressed) return;
                this.stop().catch((e) => console.warn("[camera-streamer] stop on key:", e));
            }),
        );
    }

    async stop(): Promise<void> {
        if (!this.active) return;
        this.active = false;
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        for (const h of this.listeners) {
            try { await h.remove(); } catch { /* ignore */ }
        }
        this.listeners = [];
        this.deckCache.clear();
        if (this.video) {
            try { this.video.pause(); } catch { /* ignore */ }
            this.video.srcObject = null;
            try { this.video.remove(); } catch { /* ignore */ }
            this.video = null;
        }
        if (this.stream) {
            for (const t of this.stream.getTracks()) {
                try { t.stop(); } catch { /* ignore */ }
            }
            this.stream = null;
        }
        this.controller.setCameraStreaming(false);
        this.notifyActive();
        // Repaint Note on every deck so the user lands back on the
        // familiar home tile.
        await this.controller.repaintAll().catch((e) =>
            console.warn("[camera-streamer] repaint home:", e),
        );
    }

    private tick(): void {
        if (!this.active || !this.video) return;
        if (this.inFlight) return; // skip if previous tick is still encoding
        if (this.video.readyState < 2 /* HAVE_CURRENT_DATA */) return;
        if (this.video.videoWidth === 0 || this.video.videoHeight === 0) return;

        this.inFlight = true;
        const t0 = performance.now();
        try {
            // Synchronous fan-out: paintDeck is fully sync now (toDataURL
            // is synchronous, setKeyImage is fire-and-forget). Sequential
            // by deck is fine — encoding is CPU-bound on a single thread
            // anyway, parallel awaits would just add scheduler overhead.
            for (const deck of this.decks.values()) {
                try { this.paintDeck(deck); }
                catch (e) { console.warn(`[camera-streamer] paint deck ${deck.deckId}:`, e); }
            }
        } finally {
            this.inFlight = false;
            const dt = performance.now() - t0;
            this.tickCount++;
            // Light periodic log so we can see actual encode budget.
            if (this.tickCount % 10 === 1) {
                console.info(`[camera-streamer] tick #${this.tickCount} took ${dt.toFixed(0)} ms`);
            }
            this.lastTickStart = t0;
        }
    }

    private getCache(deck: DeckInfo): DeckCanvasCache | null {
        const cached = this.deckCache.get(deck.deckId);
        const canvasW = deck.cols * deck.keyImage.w;
        const canvasH = deck.rows * deck.keyImage.h;
        if (cached && cached.canvasW === canvasW && cached.canvasH === canvasH) {
            return cached;
        }
        const composite = document.createElement("canvas");
        composite.width = canvasW;
        composite.height = canvasH;
        // alpha:false lets the WebView skip the alpha channel during
        // toDataURL JPEG encode — measurably faster on Android Chrome.
        const cctx = composite.getContext("2d", { alpha: false });
        const tile = document.createElement("canvas");
        tile.width = deck.keyImage.w;
        tile.height = deck.keyImage.h;
        const tctx = tile.getContext("2d", { alpha: false });
        if (!cctx || !tctx) return null;
        const entry: DeckCanvasCache = {
            composite, cctx, tile, tctx,
            canvasW, canvasH,
            kw: deck.keyImage.w,
            kh: deck.keyImage.h,
        };
        this.deckCache.set(deck.deckId, entry);
        return entry;
    }

    private paintDeck(deck: DeckInfo): void {
        const v = this.video;
        if (!v) return;
        const cache = this.getCache(deck);
        if (!cache) return;

        const { composite, cctx, tile, tctx, canvasW, canvasH, kw, kh } = cache;
        const cols = deck.cols;
        const rows = deck.rows;
        const rotation = deck.keyImage.rotation ?? 0;
        const format = deck.keyImage.format === "jpeg" ? "jpeg" : "png";
        const mime = format === "jpeg" ? "image/jpeg" : "image/png";

        // Cover-fit the camera into the deck's surface area.
        const vw = v.videoWidth;
        const vh = v.videoHeight;
        const scale = Math.max(canvasW / vw, canvasH / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        cctx.drawImage(v, (canvasW - dw) / 2, (canvasH - dh) / 2, dw, dh);

        const entries: { key: number; bytes: string }[] = new Array(rows * cols);
        let count = 0;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                tctx.setTransform(1, 0, 0, 1, 0, 0);
                if (rotation !== 0) {
                    tctx.translate(kw / 2, kh / 2);
                    tctx.rotate((rotation * Math.PI) / 180);
                    tctx.translate(-kw / 2, -kh / 2);
                }
                tctx.drawImage(composite, c * kw, r * kh, kw, kh, 0, 0, kw, kh);

                // Synchronous JPEG encode — returns base64 in a data URL
                // already. Strip the "data:image/jpeg;base64," prefix.
                // ~5–10× faster than toBlob+arrayBuffer+btoa in Android
                // WebView (no encoder-thread context switch, no Blob).
                const dataUrl = tile.toDataURL(mime, StreamDeckCameraStreamer.JPEG_QUALITY);
                const comma = dataUrl.indexOf(",");
                if (comma < 0) continue;
                entries[count++] = {
                    key: r * cols + c,
                    bytes: dataUrl.substring(comma + 1),
                };
            }
        }
        if (count !== entries.length) entries.length = count;

        // One JNI crossing per deck per frame (instead of `count` of
        // them). The Capacitor bridge JSON-serializes the entire payload
        // once; per-call overhead amortizes to near zero on the JS side.
        StreamDeckPlugin.setKeyImagesBatch({
            deckId: deck.deckId,
            format,
            entries,
        }).catch((e) => {
            if (this.active) console.warn(`[camera-streamer] batch deck=${deck.deckId}:`, e);
        });
    }
}
