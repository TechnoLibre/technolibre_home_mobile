import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetPlatform, mockClearCache, mockOpenWebView } = vi.hoisted(() => ({
    mockGetPlatform: vi.fn(),
    mockClearCache: vi.fn(),
    mockOpenWebView: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
    Capacitor: { getPlatform: mockGetPlatform },
}));

vi.mock("@capgo/inappbrowser", () => ({
    InAppBrowser: {
        clearCache: mockClearCache,
        openWebView: mockOpenWebView,
    },
}));

import { WebViewUtils } from "../utils/webViewUtils";

describe("WebViewUtils", () => {
    beforeEach(() => {
        mockGetPlatform.mockReset();
        mockClearCache.mockReset();
        mockOpenWebView.mockReset();
    });

    describe("isMobile", () => {
        it("returns false on the web platform", () => {
            mockGetPlatform.mockReturnValue("web");
            expect(WebViewUtils.isMobile()).toBe(false);
        });

        it("returns true on android and ios", () => {
            mockGetPlatform.mockReturnValue("android");
            expect(WebViewUtils.isMobile()).toBe(true);
            mockGetPlatform.mockReturnValue("ios");
            expect(WebViewUtils.isMobile()).toBe(true);
        });
    });

    describe("clearCache", () => {
        it("delegates to InAppBrowser", async () => {
            mockClearCache.mockResolvedValue(undefined);
            await WebViewUtils.clearCache();
            expect(mockClearCache).toHaveBeenCalledTimes(1);
        });
    });

    describe("safeAreaScript", () => {
        it("returns a self-invoking JS string that injects a style tag", () => {
            const s = WebViewUtils.safeAreaScript();
            expect(s.startsWith("(function(){")).toBe(true);
            expect(s).toContain("__erplibre_safe_inset");
            expect(s).toContain("padding-bottom");
            expect(s).toContain("env(safe-area-inset-bottom");
            // MutationObserver re-injects on DOM rewrite (Odoo SPA).
            expect(s).toContain("MutationObserver");
        });

        it("uses a fallback of 56 px when safe-area inset is unavailable", () => {
            expect(WebViewUtils.safeAreaScript()).toContain("56px");
        });
    });

    describe("openWebViewMobile", () => {
        it("delegates the options object verbatim", async () => {
            mockOpenWebView.mockResolvedValue("ok");
            const opts = { url: "https://x", title: "T" } as any;
            await WebViewUtils.openWebViewMobile(opts);
            expect(mockOpenWebView).toHaveBeenCalledWith(opts);
        });
    });
});
