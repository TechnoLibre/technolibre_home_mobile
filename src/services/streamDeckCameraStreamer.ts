import type { PluginListenerHandle } from "@capacitor/core";
import { Camera } from "@capacitor/camera";
import { StreamDeckPlugin, DeckInfo, DeckModel } from "../plugins/streamDeckPlugin";
import { FaceDetectionPlugin } from "../plugins/faceDetectionPlugin";
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
    /** Width of the inter-key gap in composite pixels. 0 when border
     *  compensation is off — composite collapses to a contiguous grid. */
    gapW: number;
    gapH: number;
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
    private static readonly DEFAULT_FPS = 5;
    // 0.1 by default keeps USB drain low and the WebView JPEG encoder
    // fast — visible blocks but a totally usable preview.
    private static readonly DEFAULT_JPEG_QUALITY = 0.1;
    // Physical bezel between keys, expressed as a fraction of the
    // visible LCD image edge. The ratio is unit-free, so we don't need
    // the camera's resolution: drawImage handles the camera→composite
    // downscale, then we apply the ratio against deck.keyImage.{w,h}
    // (the LCD's native pixel size).
    //
    // Subtle calibration point — deck.keyImage.w is the pixel count of
    // the LCD's *visible image area*, not the whole key cap. Adjacent
    // LCD viewports are separated by:
    //   plastic bezel of cap A  +  air gap between caps  +  plastic bezel of cap B
    // So the gap to skip in image-pixel space corresponds to the full
    // LCD-to-LCD distance, not just the inter-cap air gap. Initial
    // estimates used cap-edge / cap-edge which sat too low; revised
    // here to LCD-edge / LCD-edge geometry.
    //
    // Values are best-effort measurements from external dims and the
    // assumption that each cap has ~3 mm of plastic around the LCD.
    // Hardware variance + that assumption mean the per-deck slider in
    // the diagnostic panel is the authoritative tuning surface; these
    // defaults just put the user in the neighbourhood.
    //
    //   original_v1/v2/mk2 — 30 mm cap, ~24 mm LCD,  3+3+3 mm gap → 0.40 / 0.40
    //   xl                — 30 mm cap, ~24 mm LCD,  3+7+3 mm gap → 0.54 / 0.54
    //                                       (confirmed empirically)
    //   mini              — 24 mm cap, ~20 mm LCD,  2+3+2 mm gap → 0.30 / 0.30
    //   plus              — 0.68 W / 0.30 H (confirmed empirically)
    //                       Vertical is lower than the geometry-only
    //                       estimate (0.48) suggested — the Plus has a
    //                       taller LCD viewport per cap than we
    //                       assumed, so the denominator is larger.
    //   neo               — 30 mm cap, ~24 mm LCD,  3+5+3 mm gap → 0.40 / 0.40
    private static readonly BORDER_RATIO_BY_MODEL: Record<DeckModel, { w: number; h: number }> = {
        original_v1: { w: 0.40, h: 0.40 },
        original_v2: { w: 0.40, h: 0.40 },
        mini:        { w: 0.30, h: 0.30 },
        mk2:         { w: 0.40, h: 0.40 },
        xl:          { w: 0.54, h: 0.54 },
        plus:        { w: 0.68, h: 0.30 },
        neo:         { w: 0.40, h: 0.40 },
    };
    private static readonly BORDER_RATIO_FALLBACK = { w: 0.40, h: 0.40 };

    private quality = StreamDeckCameraStreamer.DEFAULT_JPEG_QUALITY;
    private fps = StreamDeckCameraStreamer.DEFAULT_FPS;
    private facingMode: "environment" | "user" = "environment";
    private skipIdentical = false;
    private lastFrameHash = 0;
    private hashCanvas: HTMLCanvasElement | null = null;
    private hashCtx: CanvasRenderingContext2D | null = null;
    /** Face detection — when true, downscale a JPEG of the live video
     *  each tick and ship it to the ML Kit Java plugin. Returned bbox
     *  list is cached in `lastFaces` (normalised 0..1) and reprojected
     *  per-deck inside paintDeck to draw a green border on any tile
     *  framing a face. */
    private faceDetect = false;
    private faceDetectInFlight = false;
    /** Bounding boxes in normalised video coordinates (0..1). */
    private lastFaces: { x: number; y: number; w: number; h: number }[] = [];
    /** How many detections have run since enable — surfaced in the UI
     *  so the user can confirm the JNI round-trip is firing. */
    private faceDetectCalls = 0;
    /** How many of those returned ≥1 face. */
    private faceDetectHits = 0;
    /** Reused canvas for the detection JPEG. Sized to match the video
     *  aspect ratio (long edge = FACE_DETECT_LONG_EDGE) so faces aren't
     *  squashed when the user holds the phone portrait — getUserMedia
     *  reports videoWidth/videoHeight in display orientation, and a
     *  fixed-landscape canvas would non-uniformly stretch a portrait
     *  feed enough to break ML Kit on selfie distance. */
    private faceCanvas: HTMLCanvasElement | null = null;
    private faceCtx: CanvasRenderingContext2D | null = null;
    // 640 px on the long edge keeps ML Kit happy on small/distant faces
    // — 320 shrunk a 1 m subject below the practical detector floor.
    // Encoder cost stays negligible at q=0.5 (~25 KB JPEG, <2 ms
    // toDataURL on Android WebView).
    private static readonly FACE_DETECT_LONG_EDGE = 640;
    private active = false;
    private stream: MediaStream | null = null;
    private video: HTMLVideoElement | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private listeners: PluginListenerHandle[] = [];
    private decks = new Map<string, DeckInfo>();
    private deckCache = new Map<string, DeckCanvasCache>();
    /** Per-deck toggle: when true, the composite is rendered at the
     *  larger virtual size that includes inter-key gaps, and pixels
     *  falling on the bezels are simply not extracted into any tile. */
    private borderCompensation = new Map<string, boolean>();
    /** Per-deck override of the bezel ratio. Empty = use the model
     *  default from BORDER_RATIO_BY_MODEL. Lets the user fine-tune
     *  hardware where the published spec doesn't quite match what
     *  they observe. */
    private borderRatioOverride = new Map<string, { w: number; h: number }>();
    private inFlight = false;
    private listenersOut = new Set<ListenerLike>();
    private lastTickStart = 0;
    private tickCount = 0;

    constructor(private readonly controller: StreamDeckController) {}

    isActive(): boolean { return this.active; }

    getQuality(): number { return this.quality; }

    /** Clamp to a sane JPEG range. <0.1 produces unreadable blocks,
     *  >0.95 explodes byte size for negligible visual gain. */
    setQuality(q: number): void {
        if (Number.isNaN(q)) return;
        this.quality = Math.max(0.1, Math.min(1.0, q));
    }

    getFps(): number { return this.fps; }

    /** Live-update tick interval. While streaming, swap the timer in
     *  place so the new rate kicks in next tick — no need to stop and
     *  restart the camera. */
    setFps(fps: number): void {
        const clamped = Math.max(1, Math.min(30, Math.round(fps)));
        if (clamped === this.fps) return;
        this.fps = clamped;
        if (this.active && this.timer !== null) {
            clearInterval(this.timer);
            this.timer = setInterval(() => {
                try { this.tick(); }
                catch (e) { console.warn("[camera-streamer] tick:", e); }
            }, this.tickMs());
        }
    }

    getFacingMode(): "environment" | "user" { return this.facingMode; }

    /** Switch front/back camera. While streaming, swaps MediaStream in
     *  place — gets a new track from getUserMedia and points the
     *  hidden <video> element at it. The encode pipeline keeps running
     *  through the swap; first new frame appears within one tick. */
    async setFacingMode(mode: "environment" | "user"): Promise<void> {
        if (this.facingMode === mode) return;
        this.facingMode = mode;
        if (!this.active || !this.video) return;
        const old = this.stream;
        const next = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: this.facingMode,
                width: { ideal: 1280 },
                height: { ideal: 720 },
            },
            audio: false,
        });
        this.stream = next;
        this.video.srcObject = next;
        await this.video.play().catch(() => { /* autoplay best-effort */ });
        // Stop old tracks AFTER the new stream is wired so we never
        // hand the encoder a black frame between swaps.
        if (old) {
            for (const t of old.getTracks()) {
                try { t.stop(); } catch { /* ignore */ }
            }
        }
        // Reset hash so the first post-swap frame doesn't get skipped
        // as "identical" — different camera, different sensor noise.
        this.lastFrameHash = 0;
    }

    getSkipIdentical(): boolean { return this.skipIdentical; }

    setSkipIdentical(on: boolean): void {
        this.skipIdentical = !!on;
        // Reset on toggle so the very next frame is always painted —
        // otherwise enabling the option mid-still-scene leaves the deck
        // showing whatever was there before.
        this.lastFrameHash = 0;
    }

    getFaceDetect(): boolean { return this.faceDetect; }

    /** Toggle face detection. The native ML Kit plugin is always
     *  registered on Android, so the only failure mode is "no Capacitor
     *  bridge" (web preview / unit tests) — we let the per-tick call
     *  surface that as a console warning rather than gating the toggle. */
    setFaceDetect(on: boolean): void {
        this.faceDetect = !!on;
        if (!this.faceDetect) this.lastFaces = [];
        this.faceDetectCalls = 0;
        this.faceDetectHits = 0;
    }

    getFaceDetectStats(): { calls: number; hits: number; lastCount: number } {
        return {
            calls: this.faceDetectCalls,
            hits: this.faceDetectHits,
            lastCount: this.lastFaces.length,
        };
    }

    private tickMs(): number {
        return Math.max(33, Math.round(1000 / this.fps));
    }

    getBorderCompensation(deckId: string): boolean {
        // Default ON — inter-key gaps are physically present on every
        // Stream Deck, so a contiguous-grid composite always misaligns
        // the camera image across cap edges. Users can still turn it
        // off per deck if they prefer the legacy look.
        return this.borderCompensation.get(deckId) ?? true;
    }

    setBorderCompensation(deckId: string, on: boolean): void {
        this.borderCompensation.set(deckId, !!on);
        // Invalidate the cache so the next paint re-allocates the
        // composite at the new virtual size (or back to contiguous).
        this.deckCache.delete(deckId);
    }

    /** Per-model bezel ratio. Falls back to a generic value for any
     *  future model not yet enumerated in BORDER_RATIO_BY_MODEL. */
    getDefaultBorderRatio(model: DeckModel): { w: number; h: number } {
        return StreamDeckCameraStreamer.BORDER_RATIO_BY_MODEL[model]
            ?? StreamDeckCameraStreamer.BORDER_RATIO_FALLBACK;
    }

    /** Effective ratio for a deck — override when present, else the
     *  per-model default. */
    getEffectiveBorderRatio(deckId: string, model: DeckModel): { w: number; h: number } {
        return this.borderRatioOverride.get(deckId)
            ?? this.getDefaultBorderRatio(model);
    }

    hasBorderRatioOverride(deckId: string): boolean {
        return this.borderRatioOverride.has(deckId);
    }

    /** Override the bezel ratio for one deck. Triggers a cache rebuild
     *  on the next paint so the new gap takes effect within one tick.
     *  Upper bound at 0.9 — beyond that the gap eats almost all of the
     *  composite and the per-key crop becomes one or two pixels wide. */
    setBorderRatio(deckId: string, w: number, h: number): void {
        const cw = Math.max(0, Math.min(0.9, w));
        const ch = Math.max(0, Math.min(0.9, h));
        this.borderRatioOverride.set(deckId, { w: cw, h: ch });
        this.deckCache.delete(deckId);
    }

    /** Drop the override and fall back to the per-model default. */
    clearBorderRatio(deckId: string): void {
        if (!this.borderRatioOverride.delete(deckId)) return;
        this.deckCache.delete(deckId);
    }

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
                facingMode: this.facingMode,
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
        }, this.tickMs());
        this.tickCount = 0;
        this.lastTickStart = 0;
        this.lastFrameHash = 0;

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

        // Cheap "static scene" skip — sample the video into a 32×16
        // canvas, fold the bytes into an int, compare to last. ~0.3 ms.
        if (this.skipIdentical && this.frameUnchanged()) return;

        this.inFlight = true;
        const t0 = performance.now();
        try {
            // Kick face detection asynchronously — result lands in
            // `lastFaces` for the next tick. We deliberately don't await
            // here so the encode pipeline isn't blocked on detector
            // latency (~10–40 ms on Chromium).
            this.kickFaceDetect();

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

    /** Fire-and-forget face detect via the native ML Kit plugin.
     *  Pipeline per call:
     *    video → 320×180 JPEG (toDataURL, q=0.5)
     *          → base64 → JNI → ML Kit FaceDetection
     *          → normalised bbox list → lastFaces
     *  In-flight dedupe ensures a slow tick can't pile up promises;
     *  bounding boxes stay in normalised [0,1] coords so paintDeck
     *  reprojects by simply multiplying by canvasW/canvasH. */
    private kickFaceDetect(): void {
        if (!this.faceDetect || !this.video) return;
        if (this.faceDetectInFlight) return;
        if (this.video.readyState < 2) return;
        const vw = this.video.videoWidth;
        const vh = this.video.videoHeight;
        if (vw === 0 || vh === 0) return;

        // Size the detect canvas to the video aspect, long edge fixed.
        // Reallocate when the aspect changes (camera flip, orientation
        // change) so faces stay un-squashed on every frame.
        const longEdge = StreamDeckCameraStreamer.FACE_DETECT_LONG_EDGE;
        const cw = vw >= vh ? longEdge : Math.round(longEdge * vw / vh);
        const ch = vh > vw ? longEdge : Math.round(longEdge * vh / vw);
        if (!this.faceCanvas
            || this.faceCanvas.width !== cw
            || this.faceCanvas.height !== ch) {
            this.faceCanvas = document.createElement("canvas");
            this.faceCanvas.width = cw;
            this.faceCanvas.height = ch;
            this.faceCtx = this.faceCanvas.getContext("2d", { alpha: false });
        }
        const ctx = this.faceCtx;
        const cv = this.faceCanvas;
        if (!ctx || !cv) return;
        try {
            ctx.drawImage(this.video, 0, 0, cv.width, cv.height);
        } catch (e) {
            console.warn("[camera-streamer] face frame draw:", e);
            return;
        }
        const dataUrl = cv.toDataURL("image/jpeg", 0.5);
        const comma = dataUrl.indexOf(",");
        if (comma < 0) return;
        const b64 = dataUrl.substring(comma + 1);

        this.faceDetectInFlight = true;
        this.faceDetectCalls++;
        FaceDetectionPlugin.detectFaces({ jpegBase64: b64 })
            .then((r) => {
                this.lastFaces = r.faces.map((f) => ({
                    x: f.x, y: f.y, w: f.width, h: f.height,
                }));
                if (this.lastFaces.length > 0) this.faceDetectHits++;
                this.faceDetectInFlight = false;
                // Throttled trace so logcat shows the pipeline alive
                // without flooding when the camera is empty.
                if (this.faceDetectCalls % 10 === 1
                    || this.lastFaces.length > 0) {
                    console.info(`[camera-streamer] face detect #${this.faceDetectCalls}`
                        + ` → ${this.lastFaces.length} face(s)`
                        + (this.lastFaces.length > 0
                            ? ` first=${JSON.stringify(this.lastFaces[0])}`
                            : ""));
                }
            })
            .catch((e) => {
                this.faceDetectInFlight = false;
                console.warn("[camera-streamer] face detect:", e);
            });
    }

    private frameUnchanged(): boolean {
        const v = this.video;
        if (!v) return true;
        if (!this.hashCanvas) {
            this.hashCanvas = document.createElement("canvas");
            this.hashCanvas.width = 32;
            this.hashCanvas.height = 16;
            this.hashCtx = this.hashCanvas.getContext("2d", {
                alpha: false,
                willReadFrequently: true,
            });
        }
        const ctx = this.hashCtx;
        if (!ctx) return false;
        ctx.drawImage(v, 0, 0, 32, 16);
        let h = 0;
        try {
            const img = ctx.getImageData(0, 0, 32, 16).data;
            for (let i = 0; i < img.length; i += 4) {
                h = ((h * 31) + img[i] + img[i + 1] * 7 + img[i + 2] * 13) | 0;
            }
        } catch {
            // SecurityError on tainted canvas (shouldn't happen with
            // same-origin getUserMedia) — disable the hash path.
            return false;
        }
        if (h === this.lastFrameHash) return true;
        this.lastFrameHash = h;
        return false;
    }

    private getCache(deck: DeckInfo): DeckCanvasCache | null {
        const compensate = this.borderCompensation.get(deck.deckId) ?? true;
        const ratio = this.borderRatioOverride.get(deck.deckId)
            ?? this.getDefaultBorderRatio(deck.model);
        const gapW = compensate ? Math.round(deck.keyImage.w * ratio.w) : 0;
        const gapH = compensate ? Math.round(deck.keyImage.h * ratio.h) : 0;
        const canvasW = deck.cols * deck.keyImage.w + (deck.cols - 1) * gapW;
        const canvasH = deck.rows * deck.keyImage.h + (deck.rows - 1) * gapH;

        const cached = this.deckCache.get(deck.deckId);
        if (cached
            && cached.canvasW === canvasW
            && cached.canvasH === canvasH
            && cached.gapW === gapW
            && cached.gapH === gapH) {
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
            gapW, gapH,
        };
        this.deckCache.set(deck.deckId, entry);
        return entry;
    }

    private paintDeck(deck: DeckInfo): void {
        const v = this.video;
        if (!v) return;
        const cache = this.getCache(deck);
        if (!cache) return;

        const { composite, cctx, tile, tctx, canvasW, canvasH, kw, kh, gapW, gapH } = cache;
        const cols = deck.cols;
        const rows = deck.rows;
        const rotation = deck.keyImage.rotation ?? 0;
        const format = deck.keyImage.format === "jpeg" ? "jpeg" : "png";
        const mime = format === "jpeg" ? "image/jpeg" : "image/png";

        // Cover-fit the camera into the deck's surface area (which now
        // includes the bezel gaps when border compensation is on).
        const vw = v.videoWidth;
        const vh = v.videoHeight;
        const scale = Math.max(canvasW / vw, canvasH / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        cctx.drawImage(v, (canvasW - dw) / 2, (canvasH - dh) / 2, dw, dh);

        // Stride between key origins on the composite. With gaps=0 this
        // collapses to (kw, kh) — the original contiguous layout.
        const strideW = kw + gapW;
        const strideH = kh + gapH;

        // Project face bboxes (normalised 0..1 in video space) into
        // composite pixel space using the same cover-fit transform
        // applied above. Done once per deck per tick so the inner
        // overlap test is a pure AABB check.
        const offsetX = (canvasW - dw) / 2;
        const offsetY = (canvasH - dh) / 2;
        const facesOnComposite = (this.faceDetect && this.lastFaces.length > 0)
            ? this.lastFaces.map((f) => ({
                x: f.x * vw * scale + offsetX,
                y: f.y * vh * scale + offsetY,
                w: f.w * vw * scale,
                h: f.h * vh * scale,
            }))
            : [];

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
                tctx.drawImage(composite, c * strideW, r * strideH, kw, kh, 0, 0, kw, kh);

                if (facesOnComposite.length > 0) {
                    const tx = c * strideW;
                    const ty = r * strideH;
                    let hit = false;
                    for (const f of facesOnComposite) {
                        if (f.x < tx + kw && f.x + f.w > tx
                            && f.y < ty + kh && f.y + f.h > ty) {
                            hit = true;
                            break;
                        }
                    }
                    if (hit) {
                        // Border is drawn in tile-local identity space so
                        // it stays on the visible LCD edges regardless of
                        // the deck's rotation (Plus needs 180°, Mini 270°).
                        tctx.setTransform(1, 0, 0, 1, 0, 0);
                        const lw = Math.max(2, Math.round(Math.min(kw, kh) * 0.06));
                        tctx.strokeStyle = "#00ff00";
                        tctx.lineWidth = lw;
                        tctx.strokeRect(lw / 2, lw / 2, kw - lw, kh - lw);
                    }
                }

                // Synchronous JPEG encode — returns base64 in a data URL
                // already. Strip the "data:image/jpeg;base64," prefix.
                // ~5–10× faster than toBlob+arrayBuffer+btoa in Android
                // WebView (no encoder-thread context switch, no Blob).
                const dataUrl = tile.toDataURL(mime, this.quality);
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
