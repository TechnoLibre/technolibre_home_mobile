import { afterEach, describe, expect, it, vi } from "vitest";
import { DRAFT_SAVE_MS, DraftText, joinDraftText } from "../services/chat/chatDraft";

afterEach(() => vi.useRealTimers());

describe("joinDraftText", () => {
    it("joins two texts older first, never doubling one or keeping a blank", () => {
        expect(joinDraftText("sent before", "typed after")).toBe("sent before\ntyped after");
        expect(joinDraftText("same", "same")).toBe("same");
        expect(joinDraftText("", "typed")).toBe("typed");
        expect(joinDraftText("kept", "  ")).toBe("kept");
    });
});

describe("DraftText", () => {
    const harness = () => {
        const saved: string[] = [];
        const draft = new DraftText(async (text) => { saved.push(text); });
        return { saved, draft };
    };

    it("stores the text once typing pauses for DRAFT_SAVE_MS", () => {
        vi.useFakeTimers();
        const { saved, draft } = harness();
        draft.typed("h");
        draft.typed("hel");
        vi.advanceTimersByTime(DRAFT_SAVE_MS - 1);
        expect(saved).toEqual([]);
        draft.typed("hello");
        vi.advanceTimersByTime(DRAFT_SAVE_MS);
        expect(saved).toEqual(["hello"]);
    });

    it("flush stores a waiting change at once, and nothing when none waits", () => {
        vi.useFakeTimers();
        const { saved, draft } = harness();
        draft.flush();
        draft.typed("leaving now");
        draft.flush();
        expect(saved).toEqual(["leaving now"]);
        vi.advanceTimersByTime(DRAFT_SAVE_MS);
        expect(saved).toEqual(["leaving now"]);
    });

    it("set stores at once and drops the waiting change, so a send's empty text is the last word", () => {
        vi.useFakeTimers();
        const { saved, draft } = harness();
        draft.typed("sent text");
        draft.set("");
        vi.advanceTimersByTime(DRAFT_SAVE_MS);
        draft.flush();
        expect(saved).toEqual([""]);
    });

    it("blanks only are stored as an empty text; a failed store is logged", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const saved: string[] = [];
        const draft = new DraftText(async (text) => {
            saved.push(text);
            if (text === "") throw new Error("disk full");
        });
        draft.set(" \n ");
        await Promise.resolve();
        await Promise.resolve();
        expect(saved).toEqual([""]);
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });
});
