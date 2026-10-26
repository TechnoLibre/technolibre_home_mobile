// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../utils/biometryUtils", () => ({ BiometryUtils: { authenticateIfAvailable: vi.fn().mockResolvedValue(false) } }));

import { ApplicationsComponent } from "../components/applications/applications_component";

function make(posts: number, files: number) {
    (globalThis as any).localStorage = {
        getItem: (k: string) => (k === "app_lang" ? "en" : null),
        setItem: () => {},
        removeItem: () => {},
    };
    const app = { url: "https://odoo.example.test", username: "alice", database: "db1" };
    const c = new (ApplicationsComponent as any)();
    c.env = {
        appService: { getMatch: vi.fn().mockResolvedValue(app) },
        syncService: {
            chat: { queue: {
                pendingPostCount: vi.fn().mockResolvedValue(posts),
                pendingUploadCount: vi.fn().mockResolvedValue(files),
            } },
        },
    };
    return c;
}

afterEach(() => { delete (globalThis as any).localStorage; vi.restoreAllMocks(); });

describe("deleting an application announces what is unsent", () => {
    const id = { url: "https://odoo.example.test", username: "alice" };

    it("lists the unsent messages and the unsent files", async () => {
        const ask = vi.spyOn(window, "confirm").mockReturnValue(false);
        await make(2, 3).deleteApplication(id);
        const text = ask.mock.calls[0][0] as string;
        expect(text).toContain("2 message(s)");
        expect(text).toContain("3 file(s)");
    });

    it("says nothing about files when none is waiting", async () => {
        const ask = vi.spyOn(window, "confirm").mockReturnValue(false);
        await make(2, 0).deleteApplication(id);
        expect(ask.mock.calls[0][0]).not.toContain("file(s)");
    });

    it("announces files alone", async () => {
        const ask = vi.spyOn(window, "confirm").mockReturnValue(false);
        await make(0, 1).deleteApplication(id);
        const text = ask.mock.calls[0][0] as string;
        expect(text).toContain("1 file(s)");
        expect(text).not.toContain("message(s)");
    });
});
