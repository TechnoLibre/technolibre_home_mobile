import { assertUrlAllowed } from "../odoo/httpPolicy";
import { SessionExpiredError, type OdooRpcClient, type SyncCredentials } from "../odoo/odooRpcClient";
import type { ChatCsrf } from "./chatCsrf";
import type { ChatFiles, ChatHttp, DownloadAnswer, HttpAnswer } from "./chatFiles";

/** The server module's upload route (module 1.2): Odoo's fields plus client_uuid, idempotent on it. */
export const MODULE_UPLOAD_ROUTE = "/erplibre_mobile_chat/attachment/upload";
/** Odoo's own upload route. */
export const ODOO_UPLOAD_ROUTE = "/mail/attachment/upload";

/**
 * Room left for the multipart envelope and the form fields: the server's
 * limit bounds the whole request, so a file fits when
 * `size + UPLOAD_SLACK_BYTES <= SessionInfo.maxUploadSize`.
 */
export const UPLOAD_SLACK_BYTES = 65536;

/** The server answered 413: the request is over its size limit. Sending it again cannot succeed. */
export class ChatFileTooBigError extends Error {}

/**
 * The server refused the transfer for good: "refused" when Odoo's route
 * answers `{error}` (not allowed to upload there), "not_found" when the
 * channel or attachment is still not found after a re-authentication.
 */
export class ChatTransferRefusedError extends Error {
    constructor(readonly reason: "refused" | "not_found", message: string) {
        super(message);
    }
}

/** The transfer was stopped by cancel(id) (ChatTransfer's, or the transport's CANCELLED). */
export class ChatTransferCancelledError extends Error {}

/** Werkzeug's BadRequest text for a missing or invalid token (odoo/http.py). */
const INVALID_CSRF = /invalid CSRF token/i;

const preview = (data: string) => data.slice(0, 200).replace(/\s+/g, " ");

/**
 * Uploads and downloads chat files with the account's session, each in one
 * rpc.callWithAuth. The upload routes and /web/content are auth="public":
 * an expired session runs there as the public user and reads 404, and a
 * session gone from the server's store gets a new session id whose CSRF
 * check fails first (400). So a first 404, or a 400 naming the CSRF token,
 * forgets the token and throws SessionExpiredError: callWithAuth logs in
 * again and calls once more, with a new session and a new token. A second
 * 404 is ChatTransferRefusedError("not_found"). Any other 400 is a plain
 * Error, to retry later: a retry overlapping the first request on the
 * module route meets its unique index and answers 400, and the next retry
 * finds the attachment.
 *
 * Errors: ChatFileTooBigError (413), ChatTransferRefusedError,
 * RequestNotSentError (nothing reached the server), ChatTransferCancelledError,
 * InsecureHttpError (http:// not allowed); anything else is a plain Error.
 *
 * cancel(id) of a running transfer holds between the requests too: the
 * id is checked before each request (the CSRF fetch included), after the
 * CSRF fetch and at the start of the attempt after a re-authentication.
 * A cancel of an id with no transfer running is forgotten at once.
 */
export class ChatTransfer {
    /** Ids of the transfers running here, and those of them cancelled. */
    private running = new Set<string>();
    private cancelled = new Set<string>();

    constructor(
        private rpc: OdooRpcClient,
        private http: ChatHttp,
        private files: ChatFiles,
        private csrf: ChatCsrf
    ) {}

    /**
     * Sends the file at a.path (relative to Directory.Data) as a pending
     * attachment of channel a.channelId. voice=true goes only for a voice
     * file (Odoo reads any value as true) and client_uuid only on the
     * module route. Returns the ir.attachment record of the answer's Store.
     */
    async upload(
        creds: SyncCredentials,
        a: {
            id: string;
            route: string;
            channelId: number;
            clientUuid: string | null;
            voice: boolean;
            path: string;
            name: string;
            mimetype: string;
        }
    ): Promise<any> {
        const url = this.serverUrl(creds, a.route);
        return this.track(a.id, async () => {
            const uri = await this.files.uri(a.path);
            let attempt = 0;
            return this.rpc.callWithAuth(creds, async (sessionId) => {
                attempt += 1;
                this.stopIfCancelled(a.id);
                const csrfToken = await this.csrf.token(creds, sessionId);
                this.stopIfCancelled(a.id);
                const fields: Record<string, string> = {
                    thread_id: String(a.channelId),
                    thread_model: "discuss.channel",
                    is_pending: "true",
                    csrf_token: csrfToken,
                };
                if (a.voice) fields.voice = "true";
                if (a.clientUuid && a.route === MODULE_UPLOAD_ROUTE) fields.client_uuid = a.clientUuid;
                const answer = await this.http.upload({
                    id: a.id,
                    url,
                    headers: { Cookie: `session_id=${sessionId}` },
                    fields,
                    file: { uri, name: a.name, mimetype: a.mimetype },
                });
                this.checkStatus(answer.status, answer.data, url, sessionId, attempt);
                return this.attachmentOf(answer, url);
            });
        });
    }

    /**
     * Downloads a.urlPath (a path of the server, query included) to a.path
     * (relative to Directory.Data). Resolves with the 2xx answer: the file
     * is then complete at its path.
     */
    async download(
        creds: SyncCredentials,
        a: { id: string; urlPath: string; path: string }
    ): Promise<DownloadAnswer> {
        const url = this.serverUrl(creds, a.urlPath);
        return this.track(a.id, async () => {
            const uri = await this.files.uri(a.path);
            let attempt = 0;
            return this.rpc.callWithAuth(creds, async (sessionId) => {
                attempt += 1;
                this.stopIfCancelled(a.id);
                const answer = await this.http.download({
                    id: a.id, url, headers: { Cookie: `session_id=${sessionId}` }, uri,
                });
                this.checkStatus(answer.status, "", url, sessionId, attempt);
                return answer;
            });
        });
    }

    /** Stops the transfer id, at its next step or in flight; it then rejects with ChatTransferCancelledError. */
    cancel(id: string): Promise<void> {
        if (this.running.has(id)) this.cancelled.add(id);
        return this.http.cancel(id);
    }

    /**
     * The server's url for path, which must start with "/": appended to a
     * base without one, it could name another host (base + "@host/…")
     * that would receive the session cookie. http:// is refused unless allowed.
     */
    private serverUrl(creds: SyncCredentials, path: string): string {
        if (!path.startsWith("/")) throw new Error(`server path must start with "/": ${path}`);
        const url = `${this.rpc.normalizeUrl(creds.odooUrl)}${path}`;
        assertUrlAllowed(url);
        return url;
    }

    /** Runs a transfer under id, its cancel mark cleared when it ends. */
    private async track<T>(id: string, run: () => Promise<T>): Promise<T> {
        this.running.add(id);
        try {
            return await run();
        } finally {
            this.running.delete(id);
            this.cancelled.delete(id);
        }
    }

    private stopIfCancelled(id: string): void {
        if (this.cancelled.has(id)) throw new ChatTransferCancelledError(`transfer ${id} cancelled`);
    }

    /** Throws for any status but 2xx, as the class comment maps them. */
    private checkStatus(status: number, data: string, url: string, sessionId: string, attempt: number): void {
        if (status >= 200 && status < 300) return;
        if (status === 404) {
            if (attempt > 1) throw new ChatTransferRefusedError("not_found", `HTTP 404 from ${url}`);
            this.csrf.forget(sessionId);
            throw new SessionExpiredError(`HTTP 404 from ${url}: session read as public`);
        }
        if (status === 400 && INVALID_CSRF.test(data)) {
            this.csrf.forget(sessionId);
            throw new SessionExpiredError(`HTTP 400 from ${url}: ${preview(data)}`);
        }
        if (status === 413) throw new ChatFileTooBigError(`HTTP 413 from ${url}`);
        throw new Error(`HTTP ${status} from ${url}: ${preview(data)}`);
    }

    /** The ir.attachment of a 200 answer `{data: Store}`; `{error}` is a refusal. */
    private attachmentOf(answer: HttpAnswer, url: string): any {
        let json: any;
        try {
            json = JSON.parse(answer.data);
        } catch {
            throw new Error(`non-JSON answer (HTTP ${answer.status}) from ${url}: ${preview(answer.data)}`);
        }
        if (json?.error) throw new ChatTransferRefusedError("refused", String(json.error));
        const records = json?.data?.["ir.attachment"];
        const record = Array.isArray(records) ? records[0] : records;
        if (!record || typeof record.id !== "number") {
            throw new Error(`no ir.attachment in the answer from ${url}: ${preview(answer.data)}`);
        }
        return record;
    }
}
