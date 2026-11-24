import { t } from "../../i18n";
import { applySuggestion, mentionQuery, type MentionPick, type MentionQuery, type Suggestion } from "../../services/chat/chatMentions";

/** Quiet time after the last keystroke before the server is asked for suggestions (Odoo's FETCH_SUGGESTIONS_DELAY). */
export const SUGGEST_FETCH_MS = 250;
/** A composer's field grows to this many lines, then scrolls. */
export const MAX_INPUT_ROWS = 5;

/** Rows a composer's field shows for a text, from 1 up to MAX_INPUT_ROWS. */
export function composerRows(text: string): number {
    return Math.min(MAX_INPUT_ROWS, text.split("\n").length);
}

/** One query as a string: its delimiter, its place and its term. */
function queryKey(q: MentionQuery): string {
    return q.kind + q.start + ":" + q.term;
}

/** Where a query's suggestions come from: the cache's, shown at once, and the server's with them, shown in their place. */
export interface MentionAsk {
    local: (q: MentionQuery) => Promise<Suggestion[]>;
    remote: (q: MentionQuery) => Promise<Suggestion[]>;
}

/** What a composer gives its MentionField. */
export interface MentionFieldHost {
    /** The composer's text field; null while it is not rendered. */
    field: () => HTMLTextAreaElement | null;
    /** The text the composer shows. */
    text: () => string;
    /** The composer's reactive state, where the suggestions shown are written. */
    view: { suggestions: Suggestion[] };
    /** The suggestions of a query; null while none can be asked (no account or conversation known yet). */
    ask: () => MentionAsk | null;
    /** A send runs: the field takes no input and no pick. */
    busy: () => boolean;
    /** The screen is gone: nothing more is shown. */
    gone: () => boolean;
    /** The text changed (typed, a pick, an emoji): the composer shows it, follows its picks and keeps it. */
    setText: (value: string) => void;
    /** A suggestion was written into the text (setText ran): the composer adds its pick and stores it. */
    picked: (pick: MentionPick, s: Suggestion) => void;
    /** The prefix of the composer's log lines. */
    label: string;
}

/**
 * The text field of a composer with its @ and # suggestions, the part a
 * conversation's composer and a record reply's share. input() takes what
 * is typed, refused while a send runs (the field keeps no disabled or
 * readonly attribute: either one, set while its text is emptied, makes
 * Android close the keyboard). The word the caret ends (mentionQuery) is
 * suggested from the cache at once, then SUGGEST_FETCH_MS after the last
 * keystroke from the server with it, which takes its place; a server that
 * fails or does not answer leaves the cache's, and an answer to a query
 * since replaced is never shown. The list shown stays until the new one
 * answers. pick() writes a suggestion over its query, insert() an emoji at
 * the caret; both go through the host's setText like typed text.
 */
export class MentionField {
    /** Counts the suggestion queries, so an answer to an older one is never shown. */
    private seq = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    /** The query the list was last asked for (kind, place, term); null when none. */
    private asked: string | null = null;

    constructor(private readonly host: MentionFieldHost) {}

    /** An edit about to happen while a send runs is refused (one the IME does not let cancel is undone by input()). */
    beforeInput(ev: Event): void {
        if (this.host.busy() && ev.cancelable) ev.preventDefault();
    }

    /** The text typed, then its suggestions; an input that still comes while a send runs is undone. */
    input(ev: Event): void {
        const field = ev.target as HTMLTextAreaElement;
        if (this.host.busy()) {
            field.value = this.host.text();
            return;
        }
        this.host.setText(field.value);
        this.suggest(field.selectionStart ?? field.value.length);
    }

    /** The suggestions of the word the caret ends; no query, or none to ask, closes the list. */
    suggest(caret: number): void {
        const q = mentionQuery(this.host.text(), caret);
        const ask = q ? this.host.ask() : null;
        if (!q || !ask) {
            this.close();
            return;
        }
        const seq = ++this.seq;
        if (this.timer !== null) clearTimeout(this.timer);
        this.asked = queryKey(q);
        let merged = false;
        const show = (list: Suggestion[]) => {
            if (seq === this.seq && !this.host.gone()) this.host.view.suggestions = list;
        };
        ask.local(q)
            .then((list: Suggestion[]) => { if (!merged) show(list); })
            .catch((e: unknown) => console.warn(this.host.label + ": suggestions", e));
        this.timer = setTimeout(() => {
            this.timer = null;
            ask.remote(q)
                .then((list: Suggestion[]) => {
                    merged = true;
                    show(list);
                })
                .catch(() => {
                    // The cache's list stays
                });
        }, SUGGEST_FETCH_MS);
    }

    /** Hides the suggestions, and voids the answers still to come and the server request still waiting. */
    close(): void {
        this.seq++;
        this.asked = null;
        this.stopTimer();
        if (this.host.view.suggestions.length) this.host.view.suggestions = [];
    }

    /**
     * The caret moved without an input (a tap in the field, an arrow key, a
     * drag of its handle): a selection or a caret that ends no query closes
     * the list, a caret that ends another query asks for its suggestions,
     * and the query already asked for is left as it is.
     */
    caret(): void {
        if (this.host.busy() || this.host.gone()) return;
        const field = this.host.field();
        if (!field) return;
        const text = this.host.text();
        const start = field.selectionStart ?? text.length;
        if (start !== (field.selectionEnd ?? start)) {
            this.close();
            return;
        }
        const q = mentionQuery(text, start);
        if (q && queryKey(q) === this.asked) return;
        this.suggest(start);
    }

    /** What the live region says: how many suggestions the list shows; "" while it is closed. */
    live(): string {
        const count = this.host.view.suggestions.length;
        return count ? t("chat.suggestions_shown", { count }) : "";
    }

    /**
     * A suggestion picked: the query the caret ends is replaced by its text
     * and a space (applySuggestion), the caret after it, the focus kept in
     * the field; the host then adds the pick. Refused while a send runs,
     * and when the caret no longer ends a query of the suggestion's kind.
     */
    pick(s: Suggestion): void {
        if (this.host.busy() || this.host.gone()) return;
        const field = this.host.field();
        const text = this.host.text();
        const caret = Math.min(field?.selectionStart ?? text.length, text.length);
        const q = mentionQuery(text, caret);
        this.close();
        if (!q || q.kind !== (s.kind === "channel" ? "#" : "@")) return;
        const picked = applySuggestion(text, q, caret, s);
        this.host.setText(picked.text);
        this.host.picked(picked.pick, s);
        if (field) {
            field.value = picked.text;
            field.setSelectionRange(picked.caret, picked.caret);
            field.focus?.();
        }
    }

    /** An emoji inserted at the caret over the selection, kept like typed text, the caret after it. Refused while a send runs. */
    insert(codepoints: string): void {
        if (this.host.busy()) return;
        const field = this.host.field();
        const text = this.host.text();
        const start = Math.min(field?.selectionStart ?? text.length, text.length);
        const end = Math.min(field?.selectionEnd ?? start, text.length);
        const value = text.slice(0, start) + codepoints + text.slice(end);
        this.host.setText(value);
        const caret = start + codepoints.length;
        if (field) {
            field.value = value;
            field.setSelectionRange(caret, caret);
        }
        this.suggest(caret);
    }

    /** The screen goes: the server request still waiting is never sent. */
    dispose(): void {
        this.stopTimer();
    }

    private stopTimer(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
    }
}
