import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockApi, handlers } = vi.hoisted(() => {
    const handlers: Record<string, (ev: any) => void> = {};
    return {
        handlers,
        mockApi: {
            getText: vi.fn(),
            upload: vi.fn(),
            download: vi.fn(),
            cancel: vi.fn(),
            addListener: vi.fn(async (name: string, fn: (ev: any) => void) => {
                handlers[name] = fn;
                return { remove: vi.fn(async () => { delete handlers[name]; }) };
            }),
        },
    };
});

vi.mock("@capacitor/core", () => ({
    registerPlugin: () => mockApi,
}));

import { CHAT_FILE_UNSENT, nativeChatHttp } from "../plugins/chatFilePlugin";
import { RequestNotSentError } from "../services/odoo/odooRpcClient";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("nativeChatHttp", () => {
    beforeEach(() => {
        Object.values(mockApi).forEach((f) => (f as any).mockClear());
        mockApi.getText.mockReset();
        mockApi.upload.mockReset();
        mockApi.download.mockReset();
        mockApi.cancel.mockReset().mockResolvedValue(undefined);
    });

    it("forwards every field of an upload and returns the answer", async () => {
        mockApi.upload.mockResolvedValue({ status: 200, headers: { "content-type": "application/json" }, data: "{}" });
        const req = {
            id: "u1",
            url: "https://odoo.example.com/mail/attachment/upload",
            headers: { Cookie: "session_id=s1" },
            fields: { thread_id: "4", thread_model: "discuss.channel", is_pending: "true", csrf_token: "t" },
            file: { uri: "file:///data/files/chat/d/out/u1/a.jpg", name: "a.jpg", mimetype: "image/jpeg" },
        };
        const answer = await nativeChatHttp().upload(req);
        expect(answer).toEqual({ status: 200, headers: { "content-type": "application/json" }, data: "{}" });
        expect(mockApi.upload).toHaveBeenCalledWith(req);
    });

    it("forwards getText, download and cancel", async () => {
        mockApi.getText.mockResolvedValue({ status: 200, headers: {}, data: "<html>" });
        mockApi.download.mockResolvedValue({ status: 200, size: 3, sha1: "ab", mimetype: "image/png" });
        const http = nativeChatHttp();
        expect((await http.getText("https://h/web/login", { Cookie: "c" })).data).toBe("<html>");
        expect(mockApi.getText).toHaveBeenCalledWith({ url: "https://h/web/login", headers: { Cookie: "c" } });
        const d = { id: "d1", url: "https://h/web/content/3", headers: {}, uri: "file:///x/chat/d/files/3/a.png" };
        expect(await http.download(d)).toEqual({ status: 200, size: 3, sha1: "ab", mimetype: "image/png" });
        expect(mockApi.download).toHaveBeenCalledWith(d);
        await http.cancel("d1");
        expect(mockApi.cancel).toHaveBeenCalledWith({ id: "d1" });
    });

    it("maps an UNSENT rejection to RequestNotSentError, and leaves others as they are", async () => {
        mockApi.upload.mockRejectedValue(Object.assign(new Error("ChatFile error: refused"), { code: CHAT_FILE_UNSENT }));
        const http = nativeChatHttp();
        const req = { id: "u", url: "u", headers: {}, fields: {}, file: { uri: "f", name: "n", mimetype: "m" } };
        await expect(http.upload(req)).rejects.toBeInstanceOf(RequestNotSentError);
        mockApi.getText.mockRejectedValue(Object.assign(new Error("ChatFile error: reset"), { code: undefined }));
        const other = http.getText("u", {});
        await expect(other).rejects.toThrow("reset");
        await expect(other).rejects.not.toBeInstanceOf(RequestNotSentError);
    });

    it("delivers progress events to subscribers until they unsubscribe", async () => {
        const http = nativeChatHttp();
        const seen: any[] = [];
        const off = http.onProgress((p) => seen.push(p));
        await flush();
        handlers.chatFileProgress({ id: "u1", done: 10, total: 100 });
        handlers.chatFileProgress({ id: "u1", done: 20, total: null });
        off();
        await flush();
        handlers.chatFileProgress?.({ id: "u1", done: 30, total: 100 });
        expect(seen).toEqual([{ id: "u1", done: 10, total: 100 }, { id: "u1", done: 20, total: null }]);
    });
});
