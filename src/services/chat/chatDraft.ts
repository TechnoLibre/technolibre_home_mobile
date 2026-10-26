/** Quiet time after the last keystroke before the draft text is stored, ms. */
export const DRAFT_SAVE_MS = 500;

/**
 * Two texts of one draft as one, the older first, a line break between:
 * a blank one or the same text twice gives the other alone, so nothing
 * typed is dropped and nothing is doubled.
 */
export function joinDraftText(older: string, newer: string): string {
    if (!newer.trim() || newer === older) return older;
    if (!older.trim()) return newer;
    return older + "\n" + newer;
}

/**
 * The text of one composer, kept as its conversation's draft. typed()
 * stores it DRAFT_SAVE_MS after the last change; flush() stores a change
 * still waiting at once (the screen closes, the app goes to the
 * background); set() stores a text at once in place of a waiting one (the
 * send's "", a refused send's text put back). Each store is asked
 * synchronously, in call order, so the last text asked is the one kept. A
 * text of blanks only is stored as "". A failed store is logged.
 */
export class DraftText {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private waiting: string | null = null;

    constructor(private save: (text: string) => Promise<void>, private delayMs = DRAFT_SAVE_MS) {}

    typed(text: string): void {
        this.waiting = text;
        this.stopTimer();
        this.timer = setTimeout(() => this.flush(), this.delayMs);
    }

    flush(): void {
        this.stopTimer();
        if (this.waiting === null) return;
        const text = this.waiting;
        this.waiting = null;
        this.store(text);
    }

    set(text: string): void {
        this.stopTimer();
        this.waiting = null;
        this.store(text);
    }

    private store(text: string): void {
        this.save(text.trim() ? text : "").catch((e) => console.warn("chat: draft text not stored", e));
    }

    private stopTimer(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
    }
}
