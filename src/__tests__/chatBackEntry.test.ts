// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { BackEntry } from "../components/chat/chatBackEntry";

/** What the browser does on a back: the entry under lands, then popstate with its state. */
function landOn(state: any) {
    window.history.replaceState(state, "");
    window.dispatchEvent(new PopStateEvent("popstate", { state }));
}

describe("BackEntry", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        window.history.replaceState({}, "");
    });

    it("close goes back once, however often it is called; the popstate calls onBack once", () => {
        const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
        const onBack = vi.fn();
        const e = new BackEntry("chatTest", onBack);
        e.open();
        expect(window.history.state).toEqual({ chatTest: true });
        e.close();
        e.close();
        expect(back).toHaveBeenCalledTimes(1);
        expect(onBack).not.toHaveBeenCalled();
        landOn({});
        landOn({});
        expect(onBack).toHaveBeenCalledTimes(1);
        e.dispose();
    });

    it("a back from a layer above, landing on its own marked entry, leaves it open", () => {
        const onBack = vi.fn();
        const e = new BackEntry("chatTest", onBack);
        e.open();
        const own = window.history.state;
        window.history.pushState({ ...own, chatAbove: true }, "");
        landOn(own);
        expect(onBack).not.toHaveBeenCalled();
        landOn({});
        expect(onBack).toHaveBeenCalledTimes(1);
        e.dispose();
    });

    it("a close while a layer above is open goes back over both: the layer closes, then this one", () => {
        const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
        const onBack = vi.fn();
        const e = new BackEntry("chatTest", onBack);
        e.open();
        const own = window.history.state;
        window.history.pushState({ ...own, chatAbove: true }, "");
        e.close();
        expect(back).toHaveBeenCalledTimes(1);
        // The first back lands on its own entry, the layer above gone: once more, over its own
        landOn(own);
        expect(onBack).not.toHaveBeenCalled();
        expect(back).toHaveBeenCalledTimes(2);
        landOn({});
        expect(onBack).toHaveBeenCalledTimes(1);
        e.dispose();
    });

    it("dispose strips its mark, or goes back over it with goBack; an entry the screen moved to is left alone", () => {
        const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
        window.history.replaceState({ kept: 1 }, "");
        const a = new BackEntry("chatTest", vi.fn());
        a.open();
        a.dispose();
        expect(window.history.state).toEqual({ kept: 1 });
        expect(back).not.toHaveBeenCalled();
        const b = new BackEntry("chatTest", vi.fn());
        b.open();
        b.dispose({ goBack: true });
        expect(back).toHaveBeenCalledTimes(1);
        window.history.replaceState({ kept: 1 }, "");
        const c = new BackEntry("chatTest", vi.fn());
        c.open();
        window.history.pushState({ route: "next" }, "");
        c.dispose({ goBack: true });
        expect(window.history.state).toEqual({ route: "next" });
        expect(back).toHaveBeenCalledTimes(1);
    });

    it("leaveAll goes back over the open layers' entries, then moves on once the popstate lands", () => {
        vi.useFakeTimers();
        const back = vi.spyOn(window.history, "go").mockImplementation(() => {});
        window.history.replaceState({ route: "inbox" }, "");
        const onBack = vi.fn();
        const e = new BackEntry("chatTest", onBack);
        e.open();
        const above = new BackEntry("chatAbove", vi.fn());
        above.open();
        const then = vi.fn();
        BackEntry.leaveAll(then);
        expect(back).toHaveBeenCalledWith(-2);
        expect(then).not.toHaveBeenCalled();
        landOn({ route: "inbox" });
        expect(then).toHaveBeenCalledTimes(1);
        // The layers going later leave every entry alone, and the timer adds nothing
        e.dispose({ goBack: true });
        above.dispose({ goBack: true });
        vi.advanceTimersByTime(2000);
        expect(then).toHaveBeenCalledTimes(1);
        expect(onBack).not.toHaveBeenCalled();
        expect(back).toHaveBeenCalledTimes(1);
        // A popstate that never comes: it moves on after a while; without a layer open, at once
        const c = new BackEntry("chatTest", vi.fn());
        c.open();
        const late = vi.fn();
        BackEntry.leaveAll(late);
        vi.advanceTimersByTime(1000);
        expect(late).toHaveBeenCalledTimes(1);
        c.dispose();
        const now = vi.fn();
        BackEntry.leaveAll(now);
        expect(now).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });

    it("closed without its entry (never opened), close calls onBack at once", () => {
        const onBack = vi.fn();
        new BackEntry("chatTest", onBack).close();
        expect(onBack).toHaveBeenCalledTimes(1);
    });
});
