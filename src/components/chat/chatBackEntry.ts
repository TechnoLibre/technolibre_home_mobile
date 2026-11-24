/**
 * A history entry of its own (same URL) for a layer over the thread (the
 * emoji picker, the message menu, who reacted, the image viewer), so
 * Android's back closes the layer and not the conversation. open() pushes
 * the entry, marked with `mark`; close() goes back over it once, and the
 * popstate that follows calls onBack; a second close() before that popstate
 * does nothing, so a double tap never leaves the conversation. A popstate
 * whose state still carries the mark lands on this entry: a layer opened
 * above went back, and this one stays, unless its own close() made that
 * back (the layer above was still open), which then goes back once more.
 *
 * dispose() is for a layer removed without a back. While its entry is
 * still the current one, it goes back over it (goBack: the layer closed
 * itself, as the picker on a send) or strips the mark from it (the screen
 * is going away, the entry stays for it); an entry the screen moved to is
 * left alone.
 */
/** How long leaveAll waits for the popstate of its back before it goes on. */
const LEAVE_WAIT_MS = 1000;

export class BackEntry {
    /** The entries opened and not disposed yet, for leaveAll. */
    private static readonly opened = new Set<BackEntry>();

    /**
     * The screen navigates away while layers are open (a tap behind them):
     * goes back over the open entries' own entries, then calls `then`
     * once the popstate has landed on the screen's entry, so the next
     * screen is pushed in their place and a back from it lands on this
     * screen, once. The layers' later dispose and popstates leave every
     * entry alone. Without an entry open, `then` runs at once; a popstate
     * that never comes runs it after LEAVE_WAIT_MS.
     */
    static leaveAll(then: () => void): void {
        const above = [...BackEntry.opened].filter((e) => e.inHistory).length;
        for (const e of BackEntry.opened) e.inHistory = false;
        if (above === 0) {
            then();
            return;
        }
        let done = false;
        const go = () => {
            if (done) return;
            done = true;
            window.removeEventListener("popstate", go);
            clearTimeout(timer);
            then();
        };
        window.addEventListener("popstate", go);
        const timer = setTimeout(go, LEAVE_WAIT_MS);
        window.history.go(-above);
    }

    private inHistory = false;
    private closing = false;
    private readonly onPop = (ev: PopStateEvent) => {
        if (!this.inHistory) return;
        if (ev.state?.[this.mark]) {
            // close() went back over a layer opened above this one: once more, over this one's own entry
            if (this.closing) window.history.back();
            return;
        }
        this.inHistory = false;
        this.closing = false;
        this.onBack();
    };

    constructor(private readonly mark: string, private readonly onBack: () => void) {}

    open(): void {
        this.closing = false;
        window.history.pushState({ ...(window.history.state ?? {}), [this.mark]: true }, "");
        this.inHistory = true;
        BackEntry.opened.add(this);
        window.addEventListener("popstate", this.onPop);
    }

    close(): void {
        if (this.closing) return;
        if (this.inHistory) {
            this.closing = true;
            window.history.back();
        } else {
            this.onBack();
        }
    }

    dispose(opts: { goBack?: boolean } = {}): void {
        window.removeEventListener("popstate", this.onPop);
        BackEntry.opened.delete(this);
        const current = window.history.state;
        if (this.inHistory && current?.[this.mark]) {
            if (opts.goBack) {
                window.history.back();
            } else {
                const rest = { ...current };
                delete rest[this.mark];
                window.history.replaceState(rest, "");
            }
        }
        this.inHistory = false;
    }
}
