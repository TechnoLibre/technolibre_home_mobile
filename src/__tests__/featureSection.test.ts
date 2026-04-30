import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockOnMounted } = vi.hoisted(() => ({
    // Capture the callback so the test runs it under controlled conditions.
    mockOnMounted: vi.fn(),
}));

vi.mock("@odoo/owl", () => ({
    onMounted: (cb: () => void) => mockOnMounted(cb),
}));

import { useFeatureSection } from "../utils/featureSection";

describe("useFeatureSection", () => {
    beforeEach(() => {
        mockOnMounted.mockReset();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    function runMount(): void {
        const cb = mockOnMounted.mock.calls.at(-1)![0];
        cb();
    }

    function stubBrowser({
        hash,
        sectionId,
        rafImmediate = true,
    }: {
        hash: string;
        sectionId: string;
        rafImmediate?: boolean;
    }) {
        const scrollIntoView = vi.fn();
        const el = sectionId ? { scrollIntoView } : null;
        vi.stubGlobal("window", { location: { hash } });
        vi.stubGlobal("document", {
            getElementById: vi.fn((id: string) => (id === sectionId ? el : null)),
        });
        vi.stubGlobal("requestAnimationFrame", (cb: any) => {
            if (rafImmediate) cb();
            return 1;
        });
        return { scrollIntoView };
    }

    it("does nothing when the hash does not match", () => {
        const expand = vi.fn();
        stubBrowser({ hash: "#other", sectionId: "target" });
        useFeatureSection("target", expand);
        runMount();
        expect(expand).not.toHaveBeenCalled();
    });

    it("calls autoExpand and scrolls when the hash matches", () => {
        const expand = vi.fn();
        const { scrollIntoView } = stubBrowser({ hash: "#target", sectionId: "target" });
        useFeatureSection("target", expand);
        runMount();
        expect(expand).toHaveBeenCalledTimes(1);
        expect(scrollIntoView).toHaveBeenCalledWith({
            behavior: "smooth", block: "start",
        });
    });

    it("strips the leading # when comparing", () => {
        const expand = vi.fn();
        stubBrowser({ hash: "#sync", sectionId: "sync" });
        useFeatureSection("sync", expand);
        runMount();
        expect(expand).toHaveBeenCalled();
    });

    it("scrolls even when autoExpand throws", () => {
        const expand = vi.fn(() => { throw new Error("nope"); });
        const { scrollIntoView } = stubBrowser({ hash: "#sync", sectionId: "sync" });
        useFeatureSection("sync", expand);
        expect(() => runMount()).not.toThrow();
        expect(scrollIntoView).toHaveBeenCalled();
    });

    it("does nothing when window is undefined (SSR / vitest node env)", () => {
        // Don't stub window — ensure it's undefined.
        vi.stubGlobal("window", undefined);
        const expand = vi.fn();
        useFeatureSection("x", expand);
        expect(() => runMount()).not.toThrow();
        expect(expand).not.toHaveBeenCalled();
    });
});
