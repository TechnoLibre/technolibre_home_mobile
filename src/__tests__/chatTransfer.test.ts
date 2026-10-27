import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { ChatCsrf } from "../services/chat/chatCsrf";
import {
    ChatFileTooBigError, ChatTransfer, ChatTransferCancelledError, ChatTransferRefusedError,
    MODULE_UPLOAD_ROUTE, ODOO_UPLOAD_ROUTE,
} from "../services/chat/chatTransfer";
import { CHAT_FILE_CANCELLED, CHAT_FILE_UNSENT } from "../plugins/chatFilePlugin";
import type { HttpAnswer, UploadRequest } from "../services/chat/chatFiles";
import { OdooRpcClient, RequestNotSentError, type SyncCredentials, syncSessionKey } from "../services/odoo/odooRpcClient";
import { fakeChatHttp, memoryChatFiles } from "../testing/chatFakes";

const CREDS: SyncCredentials = { odooUrl: "https://odoo.example.com", username: "u", password: "p", database: "db" };
const BASE = "https://odoo.example.com";

/** A stored session sid1; each authenticate answers the next sid (sid2, sid3…), after onLogin. */
function odooAuth(onLogin: () => void = () => {}) {
    let next = 2;
    const logins: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        const headers = new Headers();
        let result: object = { uid: 2 };
        if (url.endsWith("/web/session/authenticate")) {
            onLogin();
            const sid = `sid${next++}`;
            logins.push(sid);
            headers.append("set-cookie", `session_id=${sid}; Path=/; HttpOnly`);
            result = { uid: 2, server_version_info: [18, 0, 0, "final", 0] };
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers });
    }));
    return logins;
}

const sidOf = (headers: Record<string, string>) => /session_id=(\w+)/.exec(headers.Cookie ?? "")?.[1];
const login = (sid: string) => ({ status: 200, headers: {}, data: `<input name="csrf_token" value="tok-${sid}"/>` });
const stored = { "ir.attachment": [{ id: 51, name: "a.jpg", checksum: "c1", mimetype: "image/jpeg" }] };
const ok = (): HttpAnswer => ({ status: 200, headers: { "content-type": "application/json" }, data: JSON.stringify({ data: stored }) });

function build(upload: (r: UploadRequest, n: number) => HttpAnswer | Promise<HttpAnswer>) {
    let n = 0;
    const http = fakeChatHttp({
        getText: (_url, headers) => login(sidOf(headers)!),
        upload: (r) => upload(r, ++n),
        download: (r) => ({ status: sidOf(r.headers) === "sid1" ? 404 : 200, size: 3, sha1: "abc", mimetype: "image/png" }),
    });
    const rpc = new OdooRpcClient();
    const files = memoryChatFiles();
    files.put("chat/d/out/u1/a.jpg", new Uint8Array([1, 2, 3]));
    const transfer = new ChatTransfer(rpc, http, files, new ChatCsrf(rpc, http));
    return { http, transfer, files };
}

const UPLOAD = {
    id: "op-1", route: MODULE_UPLOAD_ROUTE, channelId: 4, clientUuid: "6f1c-uuid", voice: false,
    path: "chat/d/out/u1/a.jpg", name: "a.jpg", mimetype: "image/jpeg",
};

describe("ChatTransfer", () => {
    let logins: string[];

    beforeEach(async () => {
        SecureStoragePlugin._store.clear();
        await SecureStoragePlugin.set({
            key: syncSessionKey(CREDS),
            value: JSON.stringify({ sessionId: "sid1", odooMajorVersion: 18, createdAt: new Date().toISOString() }),
        });
        logins = odooAuth();
    });
    afterEach(() => vi.unstubAllGlobals());

    it("uploads the fields, the token of the session and the file, and returns the attachment", async () => {
        const { http, transfer } = build(() => ok());
        expect(await transfer.upload(CREDS, UPLOAD)).toEqual(stored["ir.attachment"][0]);
        const up = http.calls.find((c) => c.kind === "upload")!;
        expect(up.url).toBe(`${BASE}${MODULE_UPLOAD_ROUTE}`);
        expect(up.fields).toEqual({
            thread_id: "4", thread_model: "discuss.channel", is_pending: "true",
            csrf_token: "tok-sid1", client_uuid: "6f1c-uuid",
        });
        expect(up.file).toEqual({ uri: expect.stringMatching(/chat\/d\/out\/u1\/a\.jpg$/), name: "a.jpg", mimetype: "image/jpeg" });
        expect(up.headers).toEqual({ Cookie: "session_id=sid1" });
    });

    it("sends voice only for a voice file and client_uuid only on the module route", async () => {
        const { http, transfer } = build(() => ok());
        await transfer.upload(CREDS, { ...UPLOAD, route: ODOO_UPLOAD_ROUTE, voice: true });
        const up = http.calls.find((c) => c.kind === "upload")!;
        expect(up.url).toBe(`${BASE}${ODOO_UPLOAD_ROUTE}`);
        expect(up.fields).toMatchObject({ voice: "true" });
        expect(up.fields).not.toHaveProperty("client_uuid");
    });

    it("a record's file names the record's model and id as its thread", async () => {
        const { http, transfer } = build(() => ok());
        await transfer.upload(CREDS, { ...UPLOAD, channelId: 5, threadModel: "project.task" });
        expect(http.calls.find((c) => c.kind === "upload")!.fields).toEqual({
            thread_id: "5", thread_model: "project.task", is_pending: "true", csrf_token: "tok-sid1", client_uuid: "6f1c-uuid",
        });
    });

    it("404 then re-auth uploads once more with the new session's token", async () => {
        const { http, transfer } = build((r) => (sidOf(r.headers) === "sid1" ? { status: 404, headers: {}, data: "" } : ok()));
        expect((await transfer.upload(CREDS, UPLOAD)).id).toBe(51);
        const ups = http.calls.filter((c) => c.kind === "upload");
        expect(ups.map((c) => c.fields!.csrf_token)).toEqual(["tok-sid1", "tok-sid2"]);
        expect(logins).toEqual(["sid2"]);
    });

    it("404 twice is not_found", async () => {
        const { http, transfer } = build(() => ({ status: 404, headers: {}, data: "" }));
        const failure = transfer.upload(CREDS, UPLOAD);
        await expect(failure).rejects.toBeInstanceOf(ChatTransferRefusedError);
        await expect(failure).rejects.toMatchObject({ reason: "not_found" });
        expect(http.calls.filter((c) => c.kind === "upload")).toHaveLength(2);
    });

    it("invalid CSRF re-auths with a new token", async () => {
        const csrf400 = { status: 400, headers: {}, data: "<p>Session expired (invalid CSRF token)</p>" };
        const { http, transfer } = build((r) => (r.fields.csrf_token === "tok-sid1" ? csrf400 : ok()));
        expect((await transfer.upload(CREDS, UPLOAD)).id).toBe(51);
        expect(http.calls.filter((c) => c.kind === "getText")).toHaveLength(2);
        expect(logins).toEqual(["sid2"]);
    });

    it("another 400 is retryable: a plain error, never a refusal, no re-auth", async () => {
        const { transfer } = build(() => ({ status: 400, headers: {}, data: "<p>Bad Request</p>" }));
        const failure = transfer.upload(CREDS, UPLOAD);
        await expect(failure).rejects.toThrow(/HTTP 400/);
        await expect(failure).rejects.not.toBeInstanceOf(ChatTransferRefusedError);
        expect(Object.getPrototypeOf(await failure.catch((e) => e))).toBe(Error.prototype);
        expect(logins).toEqual([]);
    });

    it("413 is too big and not retried", async () => {
        const { http, transfer } = build(() => ({ status: 413, headers: {}, data: "" }));
        await expect(transfer.upload(CREDS, UPLOAD)).rejects.toBeInstanceOf(ChatFileTooBigError);
        expect(http.calls.filter((c) => c.kind === "upload")).toHaveLength(1);
        expect(logins).toEqual([]);
    });

    it("200 with error is refused", async () => {
        const { transfer } = build(() => ({ status: 200, headers: {}, data: JSON.stringify({ error: "You are not allowed to upload an attachment here." }) }));
        const failure = transfer.upload(CREDS, UPLOAD);
        await expect(failure).rejects.toBeInstanceOf(ChatTransferRefusedError);
        await expect(failure).rejects.toMatchObject({ reason: "refused" });
    });

    it("a transfer that never left is RequestNotSentError, a cancelled one ChatTransferCancelledError", async () => {
        const unsent = build(() => { throw Object.assign(new Error("refused"), { code: CHAT_FILE_UNSENT }); });
        await expect(unsent.transfer.upload(CREDS, UPLOAD)).rejects.toBeInstanceOf(RequestNotSentError);
        const cancelled = build(() => { throw Object.assign(new Error("cancelled"), { code: CHAT_FILE_CANCELLED }); });
        await expect(cancelled.transfer.upload(CREDS, UPLOAD)).rejects.toBeInstanceOf(ChatTransferCancelledError);
    });

    it("refuses a plain http server before any request", async () => {
        const { http, transfer } = build(() => ok());
        await expect(transfer.upload({ ...CREDS, odooUrl: "http://odoo.example.com" }, UPLOAD)).rejects.toThrow();
        expect(http.calls).toHaveLength(0);
    });

    it("download writes to the path's uri with the session cookie; 404 then re-auth", async () => {
        const { http, transfer } = build(() => ok());
        const d = await transfer.download(CREDS, { id: "dl-1", urlPath: "/web/content/51?unique=c1&download=true", path: "chat/d/files/51/a.png" });
        expect(d).toEqual({ status: 200, size: 3, sha1: "abc", mimetype: "image/png" });
        const dls = http.calls.filter((c) => c.kind === "download");
        expect(dls.map((c) => c.headers)).toEqual([{ Cookie: "session_id=sid1" }, { Cookie: "session_id=sid2" }]);
        expect(dls[0].url).toBe(`${BASE}/web/content/51?unique=c1&download=true`);
        expect(dls[0].uri).toMatch(/chat\/d\/files\/51\/a\.png$/);
    });

    it("download 404 twice is not_found", async () => {
        const http = fakeChatHttp({ download: () => ({ status: 404, size: 0, sha1: null, mimetype: null }) });
        const rpc = new OdooRpcClient();
        const transfer = new ChatTransfer(rpc, http, memoryChatFiles(), new ChatCsrf(rpc, http));
        await expect(transfer.download(CREDS, { id: "dl", urlPath: "/web/image/9/512x512", path: "chat/d/thumbs/9" }))
            .rejects.toMatchObject({ reason: "not_found" });
    });

    it("a redirect of the login page re-authenticates once, then uploads", async () => {
        let n = 0;
        const http = fakeChatHttp({
            getText: (_url, headers) => (++n === 1 ? { status: 303, headers: { location: "/web/database/selector" }, data: "" } : login(sidOf(headers)!)),
            upload: () => ok(),
        });
        const rpc = new OdooRpcClient();
        const files = memoryChatFiles();
        const transfer = new ChatTransfer(rpc, http, files, new ChatCsrf(rpc, http));
        expect((await transfer.upload(CREDS, UPLOAD)).id).toBe(51);
        expect(logins).toEqual(["sid2"]);
        expect(http.calls.find((c) => c.kind === "upload")!.fields!.csrf_token).toBe("tok-sid2");
    });

    it("a cancel during the CSRF fetch stops the upload before it is sent", async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const http = fakeChatHttp({
            getText: async (_url, headers) => { await gate; return login(sidOf(headers)!); },
            upload: () => ok(),
        });
        const rpc = new OdooRpcClient();
        const transfer = new ChatTransfer(rpc, http, memoryChatFiles(), new ChatCsrf(rpc, http));
        const running = transfer.upload(CREDS, UPLOAD);
        await vi.waitFor(() => expect(http.calls.some((c) => c.kind === "getText")).toBe(true));
        await transfer.cancel(UPLOAD.id);
        release();
        await expect(running).rejects.toBeInstanceOf(ChatTransferCancelledError);
        expect(http.calls.filter((c) => c.kind === "upload")).toHaveLength(0);
    });

    it("a cancel during the re-authentication stops the second attempt", async () => {
        let transfer!: ChatTransfer;
        vi.unstubAllGlobals();
        logins = odooAuth(() => void transfer.cancel(UPLOAD.id));
        const built = build(() => ({ status: 404, headers: {}, data: "" }));
        transfer = built.transfer;
        await expect(transfer.upload(CREDS, UPLOAD)).rejects.toBeInstanceOf(ChatTransferCancelledError);
        expect(built.http.calls.filter((c) => c.kind === "upload")).toHaveLength(1);
        expect(logins).toEqual(["sid2"]);
    });

    it("a cancel after the transfer ended does not stop the next one with the same id", async () => {
        const { transfer } = build(() => ok());
        await transfer.upload(CREDS, UPLOAD);
        await transfer.cancel(UPLOAD.id);
        expect((await transfer.upload(CREDS, UPLOAD)).id).toBe(51);
    });

    it("refuses a route or url path that does not start with a slash", async () => {
        const { http, transfer } = build(() => ok());
        await expect(transfer.upload(CREDS, { ...UPLOAD, route: "@elsewhere.example/upload" })).rejects.toThrow(/path/);
        await expect(transfer.download(CREDS, { id: "d", urlPath: ".elsewhere.example/web/content/1", path: "chat/d/x" }))
            .rejects.toThrow(/path/);
        expect(http.calls).toHaveLength(0);
    });

    it("cancel reaches the transport", async () => {
        const { http, transfer } = build(() => ok());
        await transfer.cancel("dl-1");
        expect(http.calls).toEqual([{ kind: "cancel", url: "", id: "dl-1" }]);
    });
});
