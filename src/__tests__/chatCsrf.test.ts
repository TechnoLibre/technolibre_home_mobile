import { describe, it, expect } from "vitest";
import { ChatCsrf } from "../services/chat/chatCsrf";
import { OdooRpcClient, SessionExpiredError, type SyncCredentials } from "../services/odoo/odooRpcClient";
import { fakeChatHttp } from "../testing/chatFakes";

const CREDS: SyncCredentials = { odooUrl: "https://odoo.example.com/", username: "u", password: "p", database: "db" };

const loginForm = (token: string) =>
    `<form><input type="hidden" name="csrf_token" value="${token}"/><input name="login"/></form>`;
const layoutScript = (token: string) => `<script>var odoo = { csrf_token: "${token}", debug: "" };</script>`;

describe("ChatCsrf", () => {
    it("reads the token from the login form, with the session cookie and no redirect param", async () => {
        const http = fakeChatHttp({ getText: () => ({ status: 200, headers: {}, data: loginForm("aa11o1790000000") }) });
        const csrf = new ChatCsrf(new OdooRpcClient(), http);
        expect(await csrf.token(CREDS, "sid1")).toBe("aa11o1790000000");
        expect(http.calls).toEqual([
            { kind: "getText", url: "https://odoo.example.com/web/login", headers: { Cookie: "session_id=sid1" } },
        ]);
    });

    it("reads the token from the layout script when the form has none", async () => {
        const http = fakeChatHttp({ getText: () => ({ status: 200, headers: {}, data: layoutScript("bb22o1790000000") }) });
        expect(await new ChatCsrf(new OdooRpcClient(), http).token(CREDS, "sid1")).toBe("bb22o1790000000");
    });

    it("caches per session id, fetches again for a new id and after forget", async () => {
        let n = 0;
        const http = fakeChatHttp({ getText: () => ({ status: 200, headers: {}, data: loginForm(`t${++n}o1`) }) });
        const csrf = new ChatCsrf(new OdooRpcClient(), http);
        const [a, b] = await Promise.all([csrf.token(CREDS, "sid1"), csrf.token(CREDS, "sid1")]);
        expect([a, b]).toEqual(["t1o1", "t1o1"]);
        expect(await csrf.token(CREDS, "sid2")).toBe("t2o1");
        expect(await csrf.token(CREDS, "sid1")).toBe("t1o1");
        csrf.forget("sid1");
        expect(await csrf.token(CREDS, "sid1")).toBe("t3o1");
        expect(http.calls).toHaveLength(3);
    });

    it("a redirect is an expired session, a page without a token an error, neither cached", async () => {
        let answer = { status: 303, headers: { location: "/web/database/selector" }, data: "" };
        const http = fakeChatHttp({ getText: () => answer });
        const csrf = new ChatCsrf(new OdooRpcClient(), http);
        const redirected = csrf.token(CREDS, "sid1");
        await expect(redirected).rejects.toBeInstanceOf(SessionExpiredError);
        await expect(redirected).rejects.toThrow(/303/);
        answer = { status: 500, headers: {}, data: "" };
        const failed = csrf.token(CREDS, "sid1");
        await expect(failed).rejects.toThrow(/500/);
        await expect(failed).rejects.not.toBeInstanceOf(SessionExpiredError);
        answer = { status: 200, headers: {}, data: "<html>nothing</html>" };
        await expect(csrf.token(CREDS, "sid1")).rejects.toThrow(/csrf/i);
        answer = { status: 200, headers: {}, data: loginForm("c3o1") };
        expect(await csrf.token(CREDS, "sid1")).toBe("c3o1");
    });

    it("refuses a plain http url unless allowed", async () => {
        const http = fakeChatHttp({ getText: () => ({ status: 200, headers: {}, data: loginForm("x") }) });
        const csrf = new ChatCsrf(new OdooRpcClient(), http);
        await expect(csrf.token({ ...CREDS, odooUrl: "http://odoo.example.com" }, "sid1")).rejects.toThrow();
        expect(http.calls).toHaveLength(0);
    });
});
