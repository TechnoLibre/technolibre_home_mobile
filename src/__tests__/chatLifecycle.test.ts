// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

import { ChatLifecycle } from "../services/chat/chatLifecycle";

function fake(maybePurge: any = vi.fn().mockResolvedValue(null)) {
    return {
        startRealtime: vi.fn().mockResolvedValue(undefined),
        stopRealtime: vi.fn(),
        attachments: { maybePurge },
        push: { newSession: vi.fn() },
        pushActions: { start: vi.fn(), drain: vi.fn().mockResolvedValue({ applied: [], kept: [] }) },
    } as any;
}

describe("ChatLifecycle purge schedule", () => {
    it("coming to the foreground checks the purge", () => {
        const chat = fake();
        (new ChatLifecycle(chat) as any).follow(true);
        expect(chat.attachments.maybePurge).toHaveBeenCalledTimes(1);
        expect(chat.startRealtime).toHaveBeenCalled();
    });

    it("coming to the foreground starts a new push session, going to the background does not", () => {
        const chat = fake();
        const lifecycle = new ChatLifecycle(chat) as any;
        lifecycle.follow(false);
        expect(chat.push.newSession).not.toHaveBeenCalled();
        lifecycle.follow(true);
        expect(chat.push.newSession).toHaveBeenCalledTimes(1);
    });

    it("coming to the foreground drains the native actions once the accounts are loaded", async () => {
        const chat = fake();
        let loaded!: () => void;
        chat.startRealtime.mockReturnValue(new Promise<void>((r) => { loaded = r; }));
        (new ChatLifecycle(chat) as any).follow(true);
        await Promise.resolve();
        expect(chat.pushActions.drain).not.toHaveBeenCalled();
        loaded();
        await vi.waitFor(() => expect(chat.pushActions.drain).toHaveBeenCalledTimes(1));
    });

    it("a failed realtime start still drains, going to the background does not", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const chat = fake();
        chat.startRealtime.mockRejectedValue(new Error("offline"));
        const lifecycle = new ChatLifecycle(chat) as any;
        lifecycle.follow(false);
        expect(chat.pushActions.drain).not.toHaveBeenCalled();
        lifecycle.follow(true);
        await vi.waitFor(() => expect(chat.pushActions.drain).toHaveBeenCalledTimes(1));
    });

    it("going to the background does not", () => {
        const chat = fake();
        (new ChatLifecycle(chat) as any).follow(false);
        expect(chat.attachments.maybePurge).not.toHaveBeenCalled();
        expect(chat.stopRealtime).toHaveBeenCalled();
    });

    it("a purge that fails does not stop the realtime", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const chat = fake(vi.fn().mockRejectedValue(new Error("disk")));
        (new ChatLifecycle(chat) as any).follow(true);
        await Promise.resolve();
        expect(chat.startRealtime).toHaveBeenCalled();
    });

    it("a rename moves the push to the new id even when resuming the uploads fails", async () => {
        const chat = {
            ...fake(),
            resumeUploads: vi.fn().mockRejectedValue(new Error("disk")),
            push: { newSession: vi.fn(), rekey: vi.fn().mockResolvedValue(undefined) },
        } as any;
        const apps: any = {};
        new ChatLifecycle(chat).followApplications(apps);
        await expect(apps.afterRename("old", "new")).rejects.toThrow("disk");
        expect(chat.push.rekey).toHaveBeenCalledWith("old", "new");
    });
});
