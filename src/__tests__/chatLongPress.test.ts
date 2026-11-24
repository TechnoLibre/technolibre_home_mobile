import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX, LongPress } from "../components/chat/chatLongPress";

describe("LongPress", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("fires with the pressed key after LONG_PRESS_MS, once", () => {
        const onLong = vi.fn();
        const p = new LongPress(onLong);
        p.down("m10", 100, 200);
        vi.advanceTimersByTime(LONG_PRESS_MS - 1);
        expect(onLong).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onLong).toHaveBeenCalledWith("m10");
        p.up();
        vi.advanceTimersByTime(LONG_PRESS_MS * 2);
        expect(onLong).toHaveBeenCalledTimes(1);
        expect(LONG_PRESS_MS).toBe(500);
        expect(LONG_PRESS_SLOP_PX).toBe(10);
    });

    it("a 12 px move cancels it; a move within the slop does not", () => {
        const onLong = vi.fn();
        const p = new LongPress(onLong);
        p.down("m10", 100, 200);
        p.move(106, 206);
        vi.advanceTimersByTime(LONG_PRESS_MS);
        expect(onLong).toHaveBeenCalledTimes(1);
        p.down("m11", 100, 200);
        p.move(112, 200);
        vi.advanceTimersByTime(LONG_PRESS_MS);
        expect(onLong).toHaveBeenCalledTimes(1);
    });

    it("an early up or a cancel (scroll) stops it", () => {
        const onLong = vi.fn();
        const p = new LongPress(onLong);
        p.down("m10", 0, 0);
        vi.advanceTimersByTime(LONG_PRESS_MS - 100);
        p.up();
        vi.advanceTimersByTime(LONG_PRESS_MS);
        p.down("m10", 0, 0);
        p.cancel();
        vi.advanceTimersByTime(LONG_PRESS_MS);
        expect(onLong).not.toHaveBeenCalled();
    });

    it("takeFired is true once after a press that fired, and a new press clears it", () => {
        const p = new LongPress(() => {});
        p.down("m10", 0, 0);
        p.up();
        expect(p.takeFired()).toBe(false);
        p.down("m10", 0, 0);
        vi.advanceTimersByTime(LONG_PRESS_MS);
        p.up();
        expect(p.takeFired()).toBe(true);
        expect(p.takeFired()).toBe(false);
        p.down("m10", 0, 0);
        vi.advanceTimersByTime(LONG_PRESS_MS);
        p.down("m11", 0, 0);
        expect(p.takeFired()).toBe(false);
        vi.advanceTimersByTime(LONG_PRESS_MS);
        p.cancel();
        expect(p.takeFired()).toBe(false);
    });

    it("takes its delay, slop and timer functions from the options", () => {
        const timers: (() => void)[] = [];
        const clearTimer = vi.fn();
        const onLong = vi.fn();
        const p = new LongPress(onLong, {
            delayMs: 300, slopPx: 2,
            setTimer: (fn, ms) => { expect(ms).toBe(300); timers.push(fn); return timers.length; },
            clearTimer,
        });
        p.down("u1", 0, 0);
        p.move(3, 0);
        expect(clearTimer).toHaveBeenCalledWith(1);
        p.down("u2", 0, 0);
        timers[1]();
        expect(onLong).toHaveBeenCalledWith("u2");
    });
});
