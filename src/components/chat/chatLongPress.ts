/** How long a press holds before it counts as long, in ms. */
export const LONG_PRESS_MS = 500;
/** How far, in px, the pointer may move during a press before it is taken for a scroll. */
export const LONG_PRESS_SLOP_PX = 10;

export interface LongPressOptions {
    delayMs?: number;
    slopPx?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

/**
 * A long press over pointer events: down() starts a timer, which calls
 * onLong with the pressed key once it runs out; a move beyond the slop, the
 * end of the press (up) or a scroll (cancel) stops it first. It reads
 * coordinates only and calls no preventDefault, so the press still scrolls
 * the list; the caller prevents the element's contextmenu so the system
 * menu does not open over it. takeFired tells the click that
 * follows a long press (to be swallowed) from a plain tap.
 */
export class LongPress {
    private readonly delayMs: number;
    private readonly slopPx: number;
    private readonly setTimer: (fn: () => void, ms: number) => unknown;
    private readonly clearTimer: (handle: unknown) => void;
    private timer: unknown = null;
    private x = 0;
    private y = 0;
    private fired = false;

    constructor(private readonly onLong: (key: string) => void, opts: LongPressOptions = {}) {
        this.delayMs = opts.delayMs ?? LONG_PRESS_MS;
        this.slopPx = opts.slopPx ?? LONG_PRESS_SLOP_PX;
        this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    }

    /** A press starts on key at (x, y); a press still running is dropped, and so is the mark of the last one. */
    down(key: string, x: number, y: number): void {
        this.stop();
        this.fired = false;
        this.x = x;
        this.y = y;
        this.timer = this.setTimer(() => {
            this.timer = null;
            this.fired = true;
            this.onLong(key);
        }, this.delayMs);
    }

    /** The pointer moved: beyond the slop from where the press started, the press is a scroll. */
    move(x: number, y: number): void {
        if (this.timer === null) return;
        if (Math.hypot(x - this.x, y - this.y) > this.slopPx) this.stop();
    }

    /** The press ended (pointerup); a press that did not run out does nothing. */
    up(): void {
        this.stop();
    }

    /** The press was taken by something else (pointercancel, a scroll): no click follows it to swallow. */
    cancel(): void {
        this.stop();
        this.fired = false;
    }

    /** Whether the last press ran out; true once, so only the click that ends it is swallowed. */
    takeFired(): boolean {
        const fired = this.fired;
        this.fired = false;
        return fired;
    }

    private stop(): void {
        if (this.timer === null) return;
        this.clearTimer(this.timer);
        this.timer = null;
    }
}
