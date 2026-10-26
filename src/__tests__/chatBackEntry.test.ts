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

    it("closed without its entry (never opened), close calls onBack at once", () => {
        const onBack = vi.fn();
        new BackEntry("chatTest", onBack).close();
        expect(onBack).toHaveBeenCalledTimes(1);
    });
});
