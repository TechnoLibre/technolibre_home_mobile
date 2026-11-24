// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { MentionField, SUGGEST_FETCH_MS, composerRows } from "../components/chat/mentionField";

function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A composer over the field: its text, its suggestions, a send lock, the picks it was given. */
function host(ask: { local: any; remote: any } | null = { local: vi.fn(async () => []), remote: vi.fn(async () => []) }) {
    const h = {
        textValue: "",
        busy: false,
        gone: false,
        view: { suggestions: [] as any[] },
        picks: [] as any[],
    };
    const field = new MentionField({
        field: () => null,
        text: () => h.textValue,
        view: h.view,
        ask: () => ask,
        busy: () => h.busy,
        gone: () => h.gone,
        setText: (value) => { h.textValue = value; },
        picked: (pick) => h.picks.push(pick),
        label: "test",
    });
    return { h, field, ask };
}

const typed = (value: string) => ({ target: { value, selectionStart: value.length } }) as unknown as Event;

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("MentionField", () => {
    it("an answer to a query since replaced is never shown, the server's takes the cache's place", async () => {
        vi.useFakeTimers();
        const first = deferred<any[]>();
        const ask = {
            local: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue([{ kind: "partner", id: 2, name: "Bob" }]),
            remote: vi.fn(async () => [{ kind: "partner", id: 2, name: "Bob" }, { kind: "partner", id: 9, name: "Bea" }]),
        };
        const store: Record<string, string> = { app_lang: "en" };
        vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: () => {}, removeItem: () => {} });
        const { h, field } = host(ask);
        field.input(typed("@a"));
        field.input(typed("@b"));
        first.resolve([{ kind: "partner", id: 1, name: "Ann" }]);
        await flush();
        expect(h.view.suggestions.map((s) => s.name)).toEqual(["Bob"]);
        await vi.advanceTimersByTimeAsync(SUGGEST_FETCH_MS);
        // One server request, for the last query only
        expect(ask.remote).toHaveBeenCalledTimes(1);
        expect(h.view.suggestions.map((s) => s.name)).toEqual(["Bob", "Bea"]);
        expect(field.live()).toBe("Suggestions shown: 2");
    });

    it("a send running refuses input, picks and emojis; no query or nothing to ask closes the list", async () => {
        const { h, field } = host();
        h.busy = true;
        const ev = { target: { value: "x" }, cancelable: true, preventDefault: vi.fn() } as any;
        field.beforeInput(ev);
        expect(ev.preventDefault).toHaveBeenCalled();
        field.input(ev);
        expect(ev.target.value).toBe("");
        field.insert("😀");
        field.pick({ kind: "partner", id: 2, name: "Bob" });
        expect([h.textValue, h.picks]).toEqual(["", []]);
        h.busy = false;
        h.view.suggestions = [{ kind: "partner", id: 2, name: "Bob" }];
        field.input(typed("hi "));
        expect(h.view.suggestions).toEqual([]);
        const none = host(null);
        none.h.view.suggestions = [{ kind: "partner", id: 2, name: "Bob" }];
        none.field.input(typed("@b"));
        expect(none.h.view.suggestions).toEqual([]);
    });

    it("a pick writes the suggestion over its query, then hands the pick to the composer", () => {
        const { h, field } = host();
        h.textValue = "Vu @bo";
        field.pick({ kind: "partner", id: 2, name: "Bob" });
        expect(h.textValue).toBe("Vu @Bob ");
        expect(h.picks).toEqual([{ kind: "partner", id: 2, text: "@Bob", start: 3 }]);
        // A # suggestion does not answer an @ query
        h.textValue = "@x";
        field.pick({ kind: "channel", id: 4, name: "général-test", parentName: null });
        expect(h.textValue).toBe("@x");
        expect(composerRows("a\nb\nc\nd\ne\nf")).toBe(5);
    });
});
