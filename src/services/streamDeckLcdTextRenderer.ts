import type { PluginListenerHandle } from "@capacitor/core";
import { StreamDeckPlugin, DeckInfo } from "../plugins/streamDeckPlugin";

interface DeckLcdConfig {
    text: string;
    fontSize: number;       // CSS px on the LCD canvas
    color: string;          // CSS color string
    scrollSpeed: number;    // px advanced per render tick
    scrollX: number;        // current animation offset
    lastDirtyHash: string;  // last rendered (text, fontSize, color, scrollX)
}

interface LcdCache {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    w: number;
    h: number;
}

/**
 * Renders user-typed text onto the LCD strip of decks that have one
 * (Plus has an 800×100 strip below the 8 keys; future models too).
 * Each deck has its own text + font size + colour + scroll speed.
 *
 * The renderer keeps a single 15 fps timer running. On every tick it
 * iterates known LCD-equipped decks, paints one frame, and pushes it
 * via setLcdImage. When text fits horizontally the frame is static
 * (centered) and only re-encoded when settings change. When the text
 * is wider than the LCD it scrolls left at scrollSpeed px/tick with
 * a gap between repetitions, and we re-encode every tick.
 *
 * Independent of the camera streamer — both paint different surfaces
 * (keys vs LCD) and can run simultaneously on Plus.
 */
export class StreamDeckLcdTextRenderer {
    private static readonly TICK_MS = 67; // ~15 fps
    private static readonly SCROLL_GAP_PX = 60;

    private static readonly DEFAULT_FONT_SIZE = 48;
    private static readonly DEFAULT_COLOR = "#ffffff";
    private static readonly DEFAULT_SCROLL_SPEED = 2;

    private decks = new Map<string, DeckInfo>();
    private configs = new Map<string, DeckLcdConfig>();
    private caches = new Map<string, LcdCache>();
    private listeners: PluginListenerHandle[] = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private started = false;
    private visibilityHandler: (() => void) | null = null;

    /** Wire up plugin listeners and seed the deck cache from the
     *  current snapshot. Idempotent — calling twice is a no-op. */
    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;

        try {
            const r = await StreamDeckPlugin.listDecks();
            for (const d of r.decks) {
                if (d.lcd) this.decks.set(d.deckId, d);
            }
        } catch (e) {
            console.warn("[lcd-text] listDecks at start:", e);
        }

        this.listeners.push(
            await StreamDeckPlugin.addListener("deckConnected", async (ev) => {
                try {
                    const info = ev.info ?? (await StreamDeckPlugin.getDeckInfo({ deckId: ev.deckId }));
                    if (info.lcd) this.decks.set(info.deckId, info);
                } catch (e) {
                    console.warn("[lcd-text] deckConnected:", e);
                }
            }),
        );
        this.listeners.push(
            await StreamDeckPlugin.addListener("deckDisconnected", (ev) => {
                this.decks.delete(ev.deckId);
                this.caches.delete(ev.deckId);
                // Configs intentionally kept — user might unplug/replug
                // the same deck and expect their text to come back.
            }),
        );

        this.timer = setInterval(() => {
            try { this.tick(); }
            catch (e) { console.warn("[lcd-text] tick:", e); }
        }, StreamDeckLcdTextRenderer.TICK_MS);

        // The streamDeckController issues reset() on every deck during
        // visibilitychange:hidden, which wipes the LCD strip too. Our
        // dedupe via lastDirtyHash would then keep skipping the next
        // tick because the hash didn't change. Clear the hashes on
        // visible so the upcoming tick re-paints from scratch.
        this.visibilityHandler = () => {
            if (document.visibilityState !== "visible") return;
            for (const c of this.configs.values()) c.lastDirtyHash = "";
        };
        document.addEventListener("visibilitychange", this.visibilityHandler);
    }

    async stop(): Promise<void> {
        if (!this.started) return;
        this.started = false;
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        for (const h of this.listeners) {
            try { await h.remove(); } catch { /* ignore */ }
        }
        this.listeners = [];
        if (this.visibilityHandler) {
            document.removeEventListener("visibilitychange", this.visibilityHandler);
            this.visibilityHandler = null;
        }
    }

    /** Returns true when the deck has an LCD surface we can paint to. */
    hasLcd(deckId: string): boolean {
        return this.decks.has(deckId);
    }

    private cfg(deckId: string): DeckLcdConfig {
        let c = this.configs.get(deckId);
        if (!c) {
            c = {
                text: "",
                fontSize: StreamDeckLcdTextRenderer.DEFAULT_FONT_SIZE,
                color: StreamDeckLcdTextRenderer.DEFAULT_COLOR,
                scrollSpeed: StreamDeckLcdTextRenderer.DEFAULT_SCROLL_SPEED,
                scrollX: 0,
                lastDirtyHash: "",
            };
            this.configs.set(deckId, c);
        }
        return c;
    }

    getText(deckId: string): string { return this.cfg(deckId).text; }
    getFontSize(deckId: string): number { return this.cfg(deckId).fontSize; }
    getColor(deckId: string): string { return this.cfg(deckId).color; }
    getScrollSpeed(deckId: string): number { return this.cfg(deckId).scrollSpeed; }

    setText(deckId: string, text: string): void {
        const c = this.cfg(deckId);
        c.text = text;
        c.scrollX = 0;
        c.lastDirtyHash = "";
    }

    setFontSize(deckId: string, px: number): void {
        const c = this.cfg(deckId);
        c.fontSize = Math.max(8, Math.min(120, Math.round(px)));
        c.scrollX = 0;
        c.lastDirtyHash = "";
    }

    setColor(deckId: string, color: string): void {
        const c = this.cfg(deckId);
        c.color = color;
        c.lastDirtyHash = "";
    }

    setScrollSpeed(deckId: string, px: number): void {
        const c = this.cfg(deckId);
        c.scrollSpeed = Math.max(0, Math.min(30, Math.round(px)));
        // Don't reset scrollX — let it continue from current position
        // for a smooth speed change while scrolling.
    }

    private getCache(deck: DeckInfo): LcdCache | null {
        const lcd = deck.lcd;
        if (!lcd) return null;
        const cached = this.caches.get(deck.deckId);
        if (cached && cached.w === lcd.w && cached.h === lcd.h) return cached;
        const canvas = document.createElement("canvas");
        canvas.width = lcd.w;
        canvas.height = lcd.h;
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) return null;
        const entry = { canvas, ctx, w: lcd.w, h: lcd.h };
        this.caches.set(deck.deckId, entry);
        return entry;
    }

    private tick(): void {
        for (const deck of this.decks.values()) {
            try { this.renderDeck(deck); }
            catch (e) { console.warn(`[lcd-text] render ${deck.deckId}:`, e); }
        }
    }

    private renderDeck(deck: DeckInfo): void {
        const cfg = this.cfg(deck.deckId);
        const cache = this.getCache(deck);
        if (!cache) return;
        const { canvas, ctx, w, h } = cache;

        // Measure first so we know whether to scroll or center.
        ctx.font = `${cfg.fontSize}px sans-serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const metrics = ctx.measureText(cfg.text || "");
        const textWidth = Math.ceil(metrics.width);

        const scrolling = cfg.text.length > 0
            && textWidth > w
            && cfg.scrollSpeed > 0;

        // Build a hash of "what's on the LCD right now" so static
        // frames (no scrolling, settings unchanged) only re-encode +
        // re-send once. Saves USB on Plus while idle.
        const hash = `${cfg.text}|${cfg.fontSize}|${cfg.color}|${scrolling ? cfg.scrollX : "static"}`;
        if (hash === cfg.lastDirtyHash) return;
        cfg.lastDirtyHash = hash;

        // Black background (LCD is happy with full-bleed JPEG).
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, w, h);

        if (cfg.text.length === 0) {
            this.flush(deck.deckId, canvas);
            return;
        }

        ctx.fillStyle = cfg.color;
        if (scrolling) {
            // Marquee — draw the text twice with a gap so when the
            // first instance is scrolling off the right, the second is
            // already appearing from the left edge.
            const period = textWidth + StreamDeckLcdTextRenderer.SCROLL_GAP_PX;
            cfg.scrollX = (cfg.scrollX + cfg.scrollSpeed) % period;
            const x0 = -cfg.scrollX;
            const y = h / 2;
            ctx.fillText(cfg.text, x0, y);
            ctx.fillText(cfg.text, x0 + period, y);
        } else {
            // Static, centered.
            const x = Math.max(0, (w - textWidth) / 2);
            const y = h / 2;
            ctx.fillText(cfg.text, x, y);
        }

        this.flush(deck.deckId, canvas);
    }

    private flush(deckId: string, canvas: HTMLCanvasElement): void {
        const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
        const comma = dataUrl.indexOf(",");
        if (comma < 0) return;
        const b64 = dataUrl.substring(comma + 1);
        StreamDeckPlugin.setLcdImage({ deckId, bytes: b64 }).catch((e) =>
            console.warn(`[lcd-text] setLcdImage deck=${deckId}:`, e),
        );
    }
}
