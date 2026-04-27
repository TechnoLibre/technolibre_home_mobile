import type { PluginListenerHandle } from "@capacitor/core";
import { Camera } from "@capacitor/camera";
import { StreamDeckPlugin, DeckInfo } from "../plugins/streamDeckPlugin";
import type { StreamDeckController } from "./streamDeckController";

interface ListenerLike {
    (active: boolean): void;
}

/**
 * Pumps the rear-facing camera onto every connected Stream Deck. While
 * active, the controller's "Note" tile is suppressed so the home key
 * doesn't fight the streamer for key 0. Pressing any deck key while
 * streaming also stops it — same UX as toggling the option off.
 *
 * Pipeline per tick:
 *   getUserMedia → <video> → composite canvas → per-key tile crop →
 *   JPEG → setKeyImage(deckId, key, bytes).
 *
 * Throttle is intentionally low (~3 fps) — at 32-key XL_v2 plus a
 * second deck, every tick fans out to 64 setKeyImage calls through
 * the Capacitor JNI bridge, and the deck firmware itself takes ~30 ms
 * per JPEG page. The WriterQueue coalesces by (deck, key) so we never
 * back up.
 */
export class StreamDeckCameraStreamer {
    private static readonly TICK_MS = 333; // ~3 fps
    private static readonly JPEG_QUALITY = 0.6;

    private active = false;
    private stream: MediaStream | null = null;
    private video: HTMLVideoElement | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private listeners: PluginListenerHandle[] = [];
    private decks = new Map<string, DeckInfo>();
    private inFlight = false;
    private listenersOut = new Set<ListenerLike>();

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
            this.tick().catch((e) => console.warn("[camera-streamer] tick:", e));
        }, StreamDeckCameraStreamer.TICK_MS);

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

    private async tick(): Promise<void> {
        if (!this.active || !this.video) return;
        if (this.inFlight) return; // skip if previous tick is still fanning out
        if (this.video.readyState < 2 /* HAVE_CURRENT_DATA */) return;
        if (this.video.videoWidth === 0 || this.video.videoHeight === 0) return;

        this.inFlight = true;
        try {
            const decks = Array.from(this.decks.values());
            // Render decks in parallel — different deckIds go to
            // different writer queues on the Java side.
            await Promise.all(decks.map((d) => this.paintDeck(d)));
        } finally {
            this.inFlight = false;
        }
    }

    private async paintDeck(deck: DeckInfo): Promise<void> {
        const v = this.video;
        if (!v) return;
        const cols = deck.cols;
        const rows = deck.rows;
        const kw = deck.keyImage.w;
        const kh = deck.keyImage.h;
        const rotation = deck.keyImage.rotation ?? 0;
        const format = deck.keyImage.format === "jpeg" ? "jpeg" : "png";
        const mime = format === "jpeg" ? "image/jpeg" : "image/png";

        const canvasW = cols * kw;
        const canvasH = rows * kh;

        // One composite the size of the deck, drawn cover-fit so the
        // 16:9 phone camera fills a wide deck without distortion.
        const composite = document.createElement("canvas");
        composite.width = canvasW;
        composite.height = canvasH;
        const cctx = composite.getContext("2d");
        if (!cctx) return;
        const vw = v.videoWidth;
        const vh = v.videoHeight;
        const scale = Math.max(canvasW / vw, canvasH / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        cctx.drawImage(v, (canvasW - dw) / 2, (canvasH - dh) / 2, dw, dh);

        // Reusable per-tile canvas — every tile shares the same size.
        const tile = document.createElement("canvas");
        tile.width = kw;
        tile.height = kh;
        const tctx = tile.getContext("2d");
        if (!tctx) return;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                tctx.setTransform(1, 0, 0, 1, 0, 0);
                tctx.clearRect(0, 0, kw, kh);
                if (rotation !== 0) {
                    tctx.translate(kw / 2, kh / 2);
                    tctx.rotate((rotation * Math.PI) / 180);
                    tctx.translate(-kw / 2, -kh / 2);
                }
                tctx.drawImage(composite, c * kw, r * kh, kw, kh, 0, 0, kw, kh);

                const blob = await new Promise<Blob | null>((resolve) =>
                    tile.toBlob(resolve, mime, StreamDeckCameraStreamer.JPEG_QUALITY),
                );
                if (!blob) continue;
                const buf = await blob.arrayBuffer();
                const bytes = new Uint8Array(buf);
                let bin = "";
                for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
                const b64 = btoa(bin);

                const key = r * cols + c;
                // Fire-and-forget per-key — the writer queue coalesces
                // duplicates by (deck, key) so accumulating promises is
                // safe even when frames arrive faster than USB drains.
                StreamDeckPlugin.setKeyImage({
                    deckId: deck.deckId,
                    key,
                    bytes: b64,
                    format,
                }).catch((e) => {
                    if (this.active) console.warn(`[camera-streamer] setKeyImage deck=${deck.deckId} key=${key}:`, e);
                });
            }
        }
    }
}
