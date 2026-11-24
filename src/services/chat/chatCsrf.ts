import { assertUrlAllowed } from "../odoo/httpPolicy";
import { SessionExpiredError, type OdooRpcClient, type SyncCredentials } from "../odoo/odooRpcClient";
import type { ChatHttp } from "./chatFiles";

/** The hidden input of the login form, attributes in either order. */
const FORM_TOKEN = /<input\b[^>]*\bname=["']csrf_token["'][^>]*\bvalue=["']([^"']+)["']/i;
const FORM_TOKEN_VALUE_FIRST = /<input\b[^>]*\bvalue=["']([^"']+)["'][^>]*\bname=["']csrf_token["']/i;
/** The web layout's `var odoo = { csrf_token: "…" }`. */
const LAYOUT_TOKEN = /csrf_token\s*:\s*["']([^"']+)["']/;

/**
 * CSRF tokens of the upload routes (type="http"), by session id. Odoo
 * derives the token from the session id, so a new session (a
 * re-authentication) needs a new token and an old one is never reused for
 * it. No JSON route returns the token: it is read from `GET /web/login`
 * without a `redirect` param, which renders the login page (and its token)
 * even for a logged-in session. A redirect instead means the session is
 * not usable there (gone from the server, or a database selector on a
 * multi-database server): SessionExpiredError, so callWithAuth logs in
 * again once. Concurrent requests for one session share one fetch; a
 * failed fetch is not cached.
 */
export class ChatCsrf {
    private tokens = new Map<string, Promise<string>>();

    constructor(private rpc: OdooRpcClient, private http: ChatHttp) {}

    token(creds: SyncCredentials, sessionId: string): Promise<string> {
        let token = this.tokens.get(sessionId);
        if (!token) {
            token = this.fetch(creds, sessionId);
            this.tokens.set(sessionId, token);
            token.catch(() => {
                if (this.tokens.get(sessionId) === token) this.tokens.delete(sessionId);
            });
        }
        return token;
    }

    /** Drops the token of a session, after the server refused it. */
    forget(sessionId: string): void {
        this.tokens.delete(sessionId);
    }

    private async fetch(creds: SyncCredentials, sessionId: string): Promise<string> {
        const url = `${this.rpc.normalizeUrl(creds.odooUrl)}/web/login`;
        assertUrlAllowed(url);
        const answer = await this.http.getText(url, { Cookie: `session_id=${sessionId}` });
        if (answer.status >= 300 && answer.status < 400) {
            throw new SessionExpiredError(`HTTP ${answer.status} from ${url}: redirected, no csrf token`);
        }
        if (answer.status < 200 || answer.status >= 300) {
            throw new Error(`HTTP ${answer.status} from ${url}: no csrf token`);
        }
        const found = FORM_TOKEN.exec(answer.data) ?? FORM_TOKEN_VALUE_FIRST.exec(answer.data)
            ?? LAYOUT_TOKEN.exec(answer.data);
        if (!found) throw new Error(`no csrf token in ${url}`);
        return found[1];
    }
}
