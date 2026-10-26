// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/chat/chatEmoji", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../services/chat/chatEmoji")>();
    return { ...actual, loadEmojiData: vi.fn(actual.loadEmojiData), countEmojiUse: vi.fn(actual.countEmojiUse) };
});

import { ChatEmojiPickerComponent } from "../components/chat/chat_emoji_picker_component";
import { FREQUENT_KEY, countEmojiUse, loadEmojiData } from "../services/chat/chatEmoji";

function stubStorage(lang = "en", counts?: Record<string, number>) {
    const store: Record<string, string> = { app_lang: lang };
    if (counts) store[FREQUENT_KEY] = JSON.stringify(counts);
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
    });
}

function picker() {
    const p = new (ChatEmojiPickerComponent as any)();
    const props: any = { onPick: vi.fn(), onClose: vi.fn() };
    p.props = props;
    p.setup();
    return { p, props };
}

beforeEach(() => vi.mocked(loadEmojiData).mockClear());
afterEach(() => vi.unstubAllGlobals());

describe("ChatEmojiPickerComponent", () => {
    it("shows a spinner until the data is there, loading it once", async () => {
        stubStorage();
        const { p } = picker();
        expect(p.state.data).toBeNull();
        await p.load();
        expect(p.state.data).not.toBeNull();
        expect(loadEmojiData).toHaveBeenCalledTimes(1);
    });

    it("a failed load shows an error and a retry loads again", async () => {
        stubStorage();
        vi.mocked(loadEmojiData).mockRejectedValueOnce(new Error("chunk"));
        const { p } = picker();
        await p.load();
        expect(p.state.failed).toBe(true);
        await p.load();
        expect(p.state.failed).toBe(false);
        expect(p.state.data).not.toBeNull();
    });

    it("search « rieur » in French finds the grinning face", async () => {
        stubStorage("fr");
        const { p } = picker();
        await p.load();
        p.onSearch({ target: { value: "rieur" } });
        expect(p.found().map((e: any) => e.codepoints)).toContain("😀");
        expect(p.sections()).toEqual([]);
    });

    it("the frequent emojis come first, then the categories in sortId order", async () => {
        stubStorage("en", { "🙏": 5, "😀": 2 });
        const { p } = picker();
        await p.load();
        const sections = p.sections();
        expect(sections[0].id).toBe("frequent");
        expect(sections[0].emojis.map((e: any) => e.codepoints)).toEqual(["🙏", "😀"]);
        expect(sections.slice(1).map((s: any) => s.title)).toEqual(["🙂", "🤟", "🐢", "🍭", "🚗", "🏈", "📕", "🔠"]);
        expect(sections[1].label).toBe("Smileys & Emotion");
    });

    it("without any use, no frequent section", async () => {
        stubStorage();
        const { p } = picker();
        await p.load();
        expect(p.sections()[0].id).not.toBe("frequent");
    });

    it("a pick counts the use, then hands the codepoints over", async () => {
        stubStorage();
        const { p, props } = picker();
        await p.load();
        p.pick("😀");
        expect(countEmojiUse).toHaveBeenCalledWith("😀");
        expect(props.onPick).toHaveBeenCalledWith("😀");
    });

    it("a pick for a reaction is not counted here (the reaction counts it)", async () => {
        stubStorage();
        const { p, props } = picker();
        props.countUse = false;
        await p.load();
        vi.mocked(countEmojiUse).mockClear();
        p.pick("😀");
        expect(countEmojiUse).not.toHaveBeenCalled();
        expect(props.onPick).toHaveBeenCalledWith("😀");
    });

    it("the sections beyond the first are filled in after the first paint, a tab asks for all of them", async () => {
        stubStorage();
        const { p } = picker();
        await p.load();
        expect(p.state.filled).toBeLessThan(p.state.data.categories.length);
        p.goTo("Symbols");
        expect(p.state.filled).toBe(p.state.data.categories.length);
    });
});
