import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BundleCodeService } from "../services/bundleCodeService";

// ── fetch mock helpers ────────────────────────────────────────────────────────

function mockFetch(responses: Record<string, unknown>) {
    return vi.fn((url: string) => {
        const key = url.replace(/^https?:\/\/[^/]+/, ""); // strip origin if present
        if (key in responses) {
            const body = responses[key];
            const text = typeof body === "string" ? body : JSON.stringify(body);
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve(body),
                text: () => Promise.resolve(text),
            });
        }
        return Promise.resolve({ ok: false, status: 404, statusText: "Not Found" });
    });
}

const SAMPLE_INDEX = [
    { path: "src",              type: "dir"  },
    { path: "src/index.ts",    type: "file" },
    { path: "src/utils.ts",    type: "file" },
    { path: "src/lib",         type: "dir"  },
    { path: "src/lib/math.ts", type: "file" },
    { path: "README.md",       type: "file" },
];

// ── BundleCodeService ─────────────────────────────────────────────────────────

describe("BundleCodeService", () => {
    let origFetch: typeof globalThis.fetch;

    beforeEach(() => {
        origFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = origFetch;
        vi.restoreAllMocks();
    });

    // ── initialize ────────────────────────────────────────────────────────────

    describe("initialize()", () => {
        it("fetches /repo/index.json by default", async () => {
            const fetch = mockFetch({ "/repo/index.json": SAMPLE_INDEX });
            globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

            const svc = new BundleCodeService();
            await svc.initialize();

            expect(fetch).toHaveBeenCalledWith("/repo/index.json");
        });

        it("uses a custom baseUrl when provided", async () => {
            const fetch = mockFetch({ "/repos/my-slug/index.json": SAMPLE_INDEX });
            globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

            const svc = new BundleCodeService("/repos/my-slug");
            await svc.initialize();

            expect(fetch).toHaveBeenCalledWith("/repos/my-slug/index.json");
        });

        it("throws when the index is not found", async () => {
            globalThis.fetch = mockFetch({}) as unknown as typeof globalThis.fetch;
            const svc = new BundleCodeService();
            await expect(svc.initialize()).rejects.toThrow();
        });
    });

    // ── listDir ───────────────────────────────────────────────────────────────

    describe("listDir()", () => {
        let svc: BundleCodeService;

        beforeEach(async () => {
            globalThis.fetch = mockFetch({
                "/repo/index.json": SAMPLE_INDEX,
            }) as unknown as typeof globalThis.fetch;
            svc = new BundleCodeService();
            await svc.initialize();
        });

        it("lists root children", async () => {
            const entries = await svc.listDir("");
            const names = entries.map((e) => e.name);
            expect(names).toContain("src");
            expect(names).toContain("README.md");
            expect(names).not.toContain("index.ts"); // deep child, not direct
        });

        it("lists direct children of src/", async () => {
            const entries = await svc.listDir("src");
            const names = entries.map((e) => e.name);
            expect(names).toContain("index.ts");
            expect(names).toContain("utils.ts");
            expect(names).toContain("lib");
            expect(names).not.toContain("math.ts"); // lives under src/lib
        });

        it("lists children of a nested directory", async () => {
            const entries = await svc.listDir("src/lib");
            expect(entries).toHaveLength(1);
            expect(entries[0].name).toBe("math.ts");
            expect(entries[0].type).toBe("file");
        });

        it("returns an empty list for a directory with no children", async () => {
            const entries = await svc.listDir("nonexistent");
            expect(entries).toEqual([]);
        });

        it("includes correct path and type in each entry", async () => {
            const entries = await svc.listDir("src");
            const file = entries.find((e) => e.name === "index.ts");
            expect(file).toBeDefined();
            expect(file!.type).toBe("file");
            expect(file!.path).toBe("src/index.ts");
        });

        it("lazy-initializes when listDir is called without initialize()", async () => {
            globalThis.fetch = mockFetch({
                "/repo/index.json": SAMPLE_INDEX,
            }) as unknown as typeof globalThis.fetch;
            const lazy = new BundleCodeService();
            // do NOT call initialize()
            const entries = await lazy.listDir("src");
            expect(entries.length).toBeGreaterThan(0);
        });
    });

    // ── readFile ──────────────────────────────────────────────────────────────

    describe("readFile()", () => {
        it("fetches the file at the expected URL", async () => {
            const fetch = mockFetch({
                "/repo/index.json": SAMPLE_INDEX,
                "/repo/src/index.ts": "export const x = 1;",
            });
            globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

            const svc = new BundleCodeService();
            const content = await svc.readFile("src/index.ts");
            expect(content).toBe("export const x = 1;");
        });

        it("throws when file is not found", async () => {
            globalThis.fetch = mockFetch({
                "/repo/index.json": SAMPLE_INDEX,
            }) as unknown as typeof globalThis.fetch;

            const svc = new BundleCodeService();
            await svc.initialize();
            await expect(svc.readFile("missing.ts")).rejects.toThrow();
        });

        it("uses the custom base URL for file fetches", async () => {
            const fetch = mockFetch({
                "/repos/slug/index.json": SAMPLE_INDEX,
                "/repos/slug/src/index.ts": "// hello",
            });
            globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

            const svc = new BundleCodeService("/repos/slug");
            const content = await svc.readFile("src/index.ts");
            expect(content).toBe("// hello");
        });
    });

    // ── getFileUrl ────────────────────────────────────────────────────────────

    describe("getFileUrl()", () => {
        it("returns the full path for the default base", () => {
            const svc = new BundleCodeService();
            expect(svc.getFileUrl("assets/logo.png")).toBe("/repo/assets/logo.png");
        });

        it("returns the correct URL with a custom base", () => {
            const svc = new BundleCodeService("/repos/my-proj");
            expect(svc.getFileUrl("images/icon.svg")).toBe("/repos/my-proj/images/icon.svg");
        });
    });
});
