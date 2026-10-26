// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

import { ChatLifecycle } from "../services/chat/chatLifecycle";

function fake(maybePurge: any = vi.fn().mockResolvedValue(null)) {
    return {
        startRealtime: vi.fn().mockResolvedValue(undefined),
        stopRealtime: vi.fn(),
        attachments: { maybePurge },
    } as any;
}

describe("ChatLifecycle purge schedule", () => {
    it("coming to the foreground checks the purge", () => {
        const chat = fake();
        (new ChatLifecycle(chat) as any).follow(true);
        expect(chat.attachments.maybePurge).toHaveBeenCalledTimes(1);
        expect(chat.startRealtime).toHaveBeenCalled();
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
});
