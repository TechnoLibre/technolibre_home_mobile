/**
 * A history entry of its own (same URL) for a sheet over the thread, so
 * Android's back closes the sheet and not the conversation. open() pushes
 * the entry, marked with `mark`; close() goes back over it once, and the
 * popstate that follows calls onBack; a second close() before that popstate
 * does nothing, so a double tap never leaves the conversation. A popstate
 * that lands on an entry still carrying the mark is a sheet opened above
 * this one going back: this one stays. dispose() is for a sheet removed
 * without a back (the screen went away): its entry, if still the current
 * one, loses its mark, so no later back is taken for it.
 */
export class BackEntry {
    private inHistory = false;
    private closing = false;
    private readonly onPop = () => {
        if (!this.inHistory || window.history.state?.[this.mark]) return;
        this.inHistory = false;
        this.onBack();
    };

    constructor(private readonly mark: string, private readonly onBack: () => void) {}

    open(): void {
        window.history.pushState({ ...(window.history.state ?? {}), [this.mark]: true }, "");
        this.inHistory = true;
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

    dispose(): void {
        window.removeEventListener("popstate", this.onPop);
        const current = window.history.state;
        if (this.inHistory && current?.[this.mark]) {
            const rest = { ...current };
            delete rest[this.mark];
            window.history.replaceState(rest, "");
        }
        this.inHistory = false;
    }
}
