import { Capacitor, CapacitorCookies } from "@capacitor/core";
import { RawHttp } from "../../plugins/rawHttpPlugin";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { StorageConstants } from "../../constants/storage";
import { assertUrlAllowed } from "./httpPolicy";

export interface SyncCredentials {
  odooUrl: string;
  username: string;
  password: string;
  database: string;
}

export interface StoredSession {
  sessionId: string;
  odooMajorVersion: number;
  /** ISO timestamp when the session was created — for local expiry enforcement. */
  createdAt?: string;
}

/** One field of fields_get, with the attributes the app asks for. */
export interface OdooFieldInfo {
  type: string;
  string?: string;
  required?: boolean;
  readonly?: boolean;
  relation?: string;
  selection?: Array<[string, string]>;
  /** Fields a computed or related field is derived from; empty or absent for a plain one. */
  depends?: string[];
}

/** Maximum session age in milliseconds (default: 24 hours). */
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Field attributes fieldsGet asks for when the caller names none. */
const DEFAULT_FIELD_ATTRIBUTES = ["type", "string", "required", "readonly", "relation", "selection", "depends"];

/**
 * Raised when Odoo reports the session as no longer valid: JSON-RPC error
 * code 100, which Odoo sends only for SessionExpiredException. callWithAuth
 * re-authenticates on this error and on HTTP 401, never on message text.
 */
export class SessionExpiredError extends Error {}

/** A JSON-RPC error, with the Odoo exception class name when sent. */
export class OdooRpcError extends Error {
  constructor(message: string, readonly odooName: string | null) {
    super(message);
  }
}

/**
 * The task a note is linked to on this server was deleted there. Raised by
 * pushNote instead of creating a new task: a record deleted on the server
 * is recreated only on explicit request (pushNote's recreateDeleted).
 * callWithAuth passes it through unwrapped.
 */
export class RemoteRecordDeletedError extends Error {}

/** An error of a subclass of Error, as opposed to a plain Error. */
function isTypedError(e: unknown): e is Error {
  return e instanceof Error && Object.getPrototypeOf(e) !== Error.prototype;
}

/**
 * SecureStorage key of the session for one url, user AND database: two
 * databases on the same url never share a session. Base64 of the UTF-8
 * bytes, since btoa() rejects characters above U+00FF.
 */
export function syncSessionKey(creds: SyncCredentials): string {
  const bytes = new TextEncoder().encode(`${creds.odooUrl}|${creds.username}|${creds.database}`);
  return StorageConstants.SYNC_SESSION_PREFIX + btoa(String.fromCharCode(...bytes));
}

/**
 * JSON-RPC transport to Odoo 16 to 18 through the standard routes only:
 * /web/session/authenticate, /web/dataset/call_kw and the public
 * database and version routes. Keeps one session per url, user and
 * database in SecureStorage and re-authenticates once when the server
 * reports it expired.
 *
 * The typed helpers (searchRead, nameSearch, fieldsGet, defaultGet,
 * checkAccess, messagePost) each run in their own authenticated call; a
 * caller chaining several calls on one session uses callWithAuth and
 * jsonRpc directly.
 */
export class OdooRpcClient {
  /** Diagnostic trail of the last authenticate() call — shown in retry errors. */
  private _lastAuthDiag: string = "";

  /**
   * Authenticates with an Odoo instance and stores the session ID in
   * SecureStorage. Returns the session ID.
   */
  async authenticate(creds: SyncCredentials): Promise<StoredSession> {
    const baseUrl = this.normalizeUrl(creds.odooUrl);
    const endpoint = `${baseUrl}/web/session/authenticate`;
    const diag: string[] = [`→ POST ${endpoint}`];

    const resp = await this.rawPost(endpoint, { "Content-Type": "application/json" }, {
      jsonrpc: "2.0", method: "call", id: 1,
      params: { db: creds.database, login: creds.username, password: creds.password },
    });

    diag.push(`← HTTP ${resp.status}`);
    const headerKeys = Object.keys(resp.headers as object);
    diag.push(`  En-têtes: [${headerKeys.join(", ") || "aucun"}]`);

    const json = this.parseNativeResponse(resp, endpoint);
    if (json.error) throw new Error(`Odoo auth error: ${json.error.data?.message ?? json.error.message}`);

    const uid = json.result?.uid;
    if (!uid) throw new Error("Authentication failed — invalid credentials");
    diag.push(`  uid: ${uid}`);

    // Try 1: Set-Cookie header — Odoo 17+ rotates the session after login and
    // sends TWO Set-Cookie directives: first the old session with Max-Age=0
    // (deletion), then the new session. We must process each directive
    // separately and skip any that are being deleted (Max-Age=0 or past Expires).
    // Joining all directives with "; " and taking the first match would give the
    // OLD (already deleted) session_id.
    let sessionId: string = "";
    const headers = resp.headers as Record<string, string | string[]>;
    for (const [key, val] of Object.entries(headers)) {
      if (key.toLowerCase() === "set-cookie") {
        const directives = Array.isArray(val) ? val : [String(val)];
        diag.push(`  [1] Set-Cookie directives (${directives.length}):`);
        for (const directive of directives) {
          const match = directive.match(/session_id=([^;,\s]+)/i);
          if (!match) continue;
          const candidate = match[1];
          const isDeleting =
            /Max-Age\s*=\s*0/i.test(directive) ||
            /Expires\s*=\s*Thu,\s*01\s*Jan\s*1970/i.test(directive);
          if (isDeleting) {
            diag.push(`    - ${candidate.slice(0, 8)}… (Max-Age=0, ignoré)`);
          } else {
            sessionId = candidate;
            diag.push(`    - ${candidate.slice(0, 8)}… ✓ (valide)`);
          }
        }
        break;
      }
    }
    if (!sessionId) diag.push(`  [1] Set-Cookie: absent ou aucun session_id valide`);

    // Try 2: Android CookieManager store — for plain HTTP requests Android may
    // consume the Set-Cookie header internally, making it invisible in resp.headers.
    // CapacitorCookies.getCookies() reads directly from the WebView cookie store.
    if (!sessionId) {
      try {
        const cookies = await CapacitorCookies.getCookies({ url: baseUrl });
        const cookieKeys = Object.keys(cookies as object);
        diag.push(`  [2] CapacitorCookies: [${cookieKeys.join(", ") || "aucun"}]`);
        const fromCookies = (cookies as Record<string, string>)["session_id"] || "";
        if (fromCookies) {
          sessionId = fromCookies;
          diag.push(`  [2] session_id via CookieStore: ${sessionId.slice(0, 8)}…`);
        }
      } catch (e) {
        diag.push(`  [2] CapacitorCookies erreur: ${e}`);
      }
    }

    // Try 3: session_id in JSON body (Odoo 16, or when neither header path worked)
    if (!sessionId) {
      const fromJson = json.result?.session_id || "";
      diag.push(`  [3] JSON result.session_id: ${fromJson ? fromJson.slice(0, 8) + "…" : "absent"}`);
      sessionId = fromJson;
    }

    if (!sessionId) {
      const resultKeys = Object.keys(json.result || {}).slice(0, 20).join(", ");
      diag.push(`  Champs result: [${resultKeys}]`);
      const msg = diag.join("\n");
      console.warn("[sync] authenticate failed:\n" + msg);
      throw new Error(`session_id introuvable\n${msg}`);
    }

    // Persist in WebKit store (port-stripped URL — WebKit ignores port for cookies).
    const cookieUrl = this.cookieUrl(baseUrl);
    try {
      await CapacitorCookies.setCookie({ url: cookieUrl, key: "session_id", value: sessionId });
      const verify = await CapacitorCookies.getCookies({ url: cookieUrl });
      const stored2 = (verify as Record<string, string>)["session_id"] || "";
      diag.push(`  [cookie-store] cookieUrl=${cookieUrl} stored=${stored2 ? stored2.slice(0, 8) + "…" : "(vide)"}`);
    } catch (e) {
      diag.push(`  [cookie-store] err: ${e}`);
    }

    // Verify the session is immediately usable by Odoo via a lightweight call.
    // This tells us whether the Cookie header we send reaches Odoo correctly.
    try {
      const infoResp = await this.rawPost(
        `${baseUrl}/web/session/get_session_info`,
        { "Content-Type": "application/json", Cookie: `session_id=${sessionId}` },
        { jsonrpc: "2.0", method: "call", id: 99, params: {} }
      );
      const infoJson = this.parseNativeResponse(infoResp, "/web/session/get_session_info");
      if (infoJson.error) {
        diag.push(`  [verify] get_session_info ÉCHEC: code=${infoJson.error.code} msg=${infoJson.error.data?.message ?? infoJson.error.message}`);
      } else {
        diag.push(`  [verify] get_session_info OK: uid=${infoJson.result?.uid} session=${String(infoJson.result?.session_id ?? "").slice(0, 8)}…`);
      }
    } catch (e) {
      diag.push(`  [verify] get_session_info ERREUR: ${e}`);
    }

    this._lastAuthDiag = diag.join("\n");
    const odooMajorVersion: number = json.result?.server_version_info?.[0] ?? 18;
    const stored: StoredSession = { sessionId, odooMajorVersion, createdAt: new Date().toISOString() };
    await SecureStoragePlugin.set({ key: syncSessionKey(creds), value: JSON.stringify(stored) });
    const legacyKey = this.legacySessionKey(creds);
    if (legacyKey) await SecureStoragePlugin.remove({ key: legacyKey }).catch(() => {});
    return stored;
  }

  /**
   * Returns the stored session. If missing or in the old plain-string format,
   * re-authenticates so the Odoo version is also captured.
   */
  async getSession(creds: SyncCredentials): Promise<StoredSession> {
    try {
      const result = await SecureStoragePlugin.get({ key: syncSessionKey(creds) });
      const parsed = JSON.parse(result.value);
      if (!parsed?.sessionId || !parsed?.odooMajorVersion) throw new Error("stale format");

      // Enforce local session expiry
      if (parsed.createdAt) {
        const age = Date.now() - new Date(parsed.createdAt).getTime();
        if (age > SESSION_MAX_AGE_MS) {
          await SecureStoragePlugin.remove({ key: syncSessionKey(creds) }).catch(() => {});
          throw new Error("session expired locally");
        }
      }

      return parsed as StoredSession;
    } catch {
      return this.authenticate(creds);
    }
  }

  /**
   * Wraps a JSON-RPC call with automatic re-auth on session expiry.
   * Passes both the session ID and the detected Odoo major version to fn.
   * Retries once after re-authenticating.
   *
   * Errors of a dedicated class (OdooRpcError, RemoteRecordDeletedError…)
   * reach the caller unwrapped, so it can still test their type; a plain
   * Error (HTTP status, unreadable answer) is wrapped with the session
   * diagnostic.
   */
  async callWithAuth<T>(
    creds: SyncCredentials,
    fn: (sessionId: string, odooVersion: number) => Promise<T>
  ): Promise<T> {
    const session = await this.getSession(creds);
    const sid = session.sessionId.slice(0, 8);
    try {
      return await fn(session.sessionId, session.odooMajorVersion);
    } catch (e: unknown) {
      if (isTypedError(e) && !(e instanceof SessionExpiredError)) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof SessionExpiredError || /^HTTP 401\b/.test(msg)) {
        // Invalidate stale cached session before re-authenticating
        await SecureStoragePlugin.remove({ key: syncSessionKey(creds) }).catch(() => {});
        let renewed: StoredSession;
        try {
          renewed = await this.authenticate(creds);
        } catch (authErr: unknown) {
          const authMsg = authErr instanceof Error ? authErr.message : String(authErr);
          throw new Error(`session expirée (${sid}…) puis re-auth échouée:\n${authMsg}`);
        }
        try {
          return await fn(renewed.sessionId, renewed.odooMajorVersion);
        } catch (retryErr: unknown) {
          if (isTypedError(retryErr) && !(retryErr instanceof SessionExpiredError)) throw retryErr;
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          throw new Error(
            `re-auth OK (${renewed.sessionId.slice(0, 8)}…) mais appel échoué:\n${retryMsg}\n\n` +
            `Diag auth:\n${this._lastAuthDiag}`
          );
        }
      }
      throw new Error(`erreur (session ${sid}…): ${msg}`);
    }
  }

  async jsonRpc(
    odooUrl: string,
    sessionId: string,
    model: string,
    method: string,
    args: any[],
    kwargs: Record<string, any> = {}
  ): Promise<any> {
    const baseUrl = this.normalizeUrl(odooUrl);
    const endpoint = `${baseUrl}/web/dataset/call_kw`;

    // RawHttp bypasses Android's CookieHandler so the Cookie header reaches Odoo.
    const resp = await this.rawPost(
      endpoint,
      { "Content-Type": "application/json", Cookie: `session_id=${sessionId}` },
      { jsonrpc: "2.0", method: "call", id: Date.now(), params: { model, method, args, kwargs } }
    );

    const json = this.parseNativeResponse(resp, endpoint);
    if (json.error) {
      const errMsg = json.error.data?.message ?? json.error.message ?? "Unknown RPC error";
      const errCode = json.error.code ?? "?";
      if (json.error.code === 100) throw new SessionExpiredError(`session_expired (code ${errCode}): ${errMsg}`);
      throw new OdooRpcError(
        `RPC ${model}.${method} (HTTP ${resp.status}, code ${errCode}): ${errMsg}`,
        json.error.data?.name ?? null
      );
    }
    return json.result;
  }

  /**
   * The id of the user the credentials log in as, from the session
   * (/web/session/get_session_info, an authenticated route), read once per
   * server and database for the app's lifetime.
   */
  async currentUid(creds: SyncCredentials): Promise<number> {
    const key = `${creds.odooUrl}|${creds.username}|${creds.database}`;
    const known = this._uids.get(key);
    if (known !== undefined) return known;
    const info = await this.callWithAuth(creds, (sessionId) =>
      this.jsonRoute(creds.odooUrl, sessionId, "/web/session/get_session_info", {}));
    const uid = Number(info?.uid);
    if (!Number.isInteger(uid) || uid <= 0) throw new Error(`Utilisateur inconnu sur ${creds.odooUrl}.`);
    this._uids.set(key, uid);
    return uid;
  }

  /** currentUid's answers, per "url|username|database". */
  private _uids = new Map<string, number>();

  /**
   * Calls a JSON route of the web client (type="json"), such as
   * /mail/message/update_content, with the session cookie. Errors are
   * raised as jsonRpc raises them; a route answering NotFound (record gone,
   * or not the user's to change) gives odooName
   * "werkzeug.exceptions.NotFound".
   */
  async jsonRoute(
    odooUrl: string,
    sessionId: string,
    path: string,
    params: Record<string, any>
  ): Promise<any> {
    const endpoint = `${this.normalizeUrl(odooUrl)}${path}`;
    const resp = await this.rawPost(
      endpoint,
      { "Content-Type": "application/json", Cookie: `session_id=${sessionId}` },
      { jsonrpc: "2.0", method: "call", id: Date.now(), params }
    );
    const json = this.parseNativeResponse(resp, endpoint);
    if (json.error) {
      const errMsg = json.error.data?.message ?? json.error.message ?? "Unknown RPC error";
      const errCode = json.error.code ?? "?";
      if (json.error.code === 100) throw new SessionExpiredError(`session_expired (code ${errCode}): ${errMsg}`);
      throw new OdooRpcError(`RPC ${path} (HTTP ${resp.status}, code ${errCode}): ${errMsg}`, json.error.data?.name ?? null);
    }
    return json.result;
  }

  // ─── Public routes ────────────────────────────────────────────────────────

  /**
   * Fetches the list of available databases from a public Odoo endpoint.
   * Returns an empty array if the server does not expose the list.
   */
  async listDatabases(url: string): Promise<string[]> {
    const baseUrl = this.normalizeUrl(url);
    const endpoint = `${baseUrl}/web/database/list`;
    const resp = await this.rawPost(endpoint, { "Content-Type": "application/json" },
      { jsonrpc: "2.0", method: "call", id: 1, params: {} });
    const json = this.parseNativeResponse(resp, endpoint);
    if (json.error) throw new Error(json.error.data?.message ?? json.error.message ?? "Unknown error");
    if (!Array.isArray(json.result)) return [];
    return json.result as string[];
  }

  /**
   * Returns the Odoo server version string (e.g. "17.0+e") from the public
   * /web/webclient/version_info endpoint. Returns null if unavailable.
   */
  async getServerVersion(url: string): Promise<string | null> {
    const baseUrl = this.normalizeUrl(url);
    const endpoint = `${baseUrl}/web/webclient/version_info`;
    try {
      const resp = await this.rawPost(endpoint, { "Content-Type": "application/json" },
        { jsonrpc: "2.0", method: "call", id: 1, params: {} });
      const json = this.parseNativeResponse(resp, endpoint);
      if (json.error || !json.result) return null;
      return (json.result.server_version as string) ?? null;
    } catch {
      return null;
    }
  }

  // ─── Typed helpers ────────────────────────────────────────────────────────

  /** Major version of the server, from the stored session (logs in if none). */
  async odooVersion(creds: SyncCredentials): Promise<number> {
    return (await this.getSession(creds)).odooMajorVersion;
  }

  /** model.method(*args, **kwargs) through call_kw, authenticated. */
  async callKw<T = any>(
    creds: SyncCredentials,
    model: string,
    method: string,
    args: any[] = [],
    kwargs: Record<string, any> = {}
  ): Promise<T> {
    return this.callWithAuth(creds, (sessionId) =>
      this.jsonRpc(creds.odooUrl, sessionId, model, method, args, kwargs)
    );
  }

  async searchRead<T = Record<string, any>>(
    creds: SyncCredentials,
    model: string,
    domain: any[],
    fields: string[],
    options: { limit?: number; offset?: number; order?: string; context?: Record<string, any> } = {}
  ): Promise<T[]> {
    return this.callKw(creds, model, "search_read", [], { domain, fields, ...options });
  }

  /**
   * Records whose display name matches name, as {id, name}. name_search
   * answers [[id, display_name], …] on every supported version.
   */
  async nameSearch(
    creds: SyncCredentials,
    model: string,
    name: string,
    options: { domain?: any[]; limit?: number; context?: Record<string, any> } = {}
  ): Promise<Array<{ id: number; name: string }>> {
    const rows: Array<[number, string]> = await this.callKw(creds, model, "name_search", [], {
      name,
      args: options.domain ?? [],
      operator: "ilike",
      limit: options.limit ?? 20,
      ...(options.context ? { context: options.context } : {}),
    });
    return (rows ?? []).map(([id, label]) => ({ id, name: label }));
  }

  /**
   * Field definitions of a model. An unknown model answers an OdooRpcError,
   * which makes this the existence test that needs no access to ir.model.
   */
  async fieldsGet(
    creds: SyncCredentials,
    model: string,
    attributes: string[] = DEFAULT_FIELD_ATTRIBUTES,
    fieldNames: string[] | null = null
  ): Promise<Record<string, OdooFieldInfo>> {
    return this.callKw(creds, model, "fields_get", fieldNames ? [fieldNames] : [], { attributes });
  }

  /** Server defaults of a new record of model for the given fields. */
  async defaultGet(
    creds: SyncCredentials,
    model: string,
    fields: string[],
    context: Record<string, any> = {}
  ): Promise<Record<string, any>> {
    return this.callKw(creds, model, "default_get", [fields], { context });
  }

  /**
   * Whether the user holds the model-level right for operation, or null
   * when the server answers none of the probes. Odoo 18 has has_access()
   * and keeps check_access_rights() deprecated; 16 and 17 have only
   * check_access_rights(). Record rules are not evaluated: a write can
   * still be refused on one record.
   */
  async checkAccess(
    creds: SyncCredentials,
    model: string,
    operation: "read" | "create" | "write" | "unlink"
  ): Promise<boolean | null> {
    const version = await this.odooVersion(creds);
    const probes: Array<() => Promise<unknown>> = [
      ...(version >= 18 ? [() => this.callKw(creds, model, "has_access", [[], operation])] : []),
      () => this.callKw(creds, model, "check_access_rights", [operation], { raise_exception: false }),
    ];
    for (const probe of probes) {
      try {
        return Boolean(await probe());
      } catch (e: unknown) {
        if (!(e instanceof OdooRpcError)) throw e;
      }
    }
    return null;
  }

  /**
   * Posts body (HTML) as a note in the record's chatter and returns the
   * mail.message id. Needs only read access on models whose
   * _mail_post_access is "read", such as account.move.
   *
   * Odoo 17 and 18 escape a body that arrives as a plain string (JSON-RPC
   * never sends Markup) unless body_is_html is set, and keep it HTML only
   * for an internal user; Odoo 16 has no such parameter and sanitizes the
   * string as HTML.
   */
  async messagePost(
    creds: SyncCredentials,
    model: string,
    resId: number,
    body: string,
    options: { subject?: string; attachmentIds?: number[] } = {}
  ): Promise<number> {
    const version = await this.odooVersion(creds);
    return this.callKw(creds, model, "message_post", [[resId]], {
      body,
      ...(version >= 17 ? { body_is_html: true } : {}),
      message_type: "comment",
      subtype_xmlid: "mail.mt_note",
      ...(options.subject ? { subject: options.subject } : {}),
      ...(options.attachmentIds?.length ? { attachment_ids: options.attachmentIds } : {}),
    });
  }

  // ─── Transport ────────────────────────────────────────────────────────────

  /**
   * Makes a POST request.
   *
   * On Android native: uses the RawHttp plugin, which bypasses Android's
   * CookieHandler so manually-set Cookie headers are preserved on plain HTTP
   * connections to IP addresses. If the plugin is absent (old APK), throws a
   * clear error — fetch() cannot be used as a fallback on Android because the
   * WebView blocks cross-origin requests (CORS) to Odoo servers.
   *
   * On web (dev mode): uses fetch() directly.
   *
   * An http:// url is refused (InsecureHttpError) unless the user allowed
   * unencrypted http in the options (see httpPolicy).
   */
  private async rawPost(
    url: string,
    headers: Record<string, string>,
    body: object
  ): Promise<{ status: number; headers: Record<string, string | string[]>; data: any }> {
    assertUrlAllowed(url);
    if (Capacitor.isNativePlatform()) {
      try {
        const resp = await RawHttp.post({ url, headers, body: JSON.stringify(body) });
        return { status: resp.status, headers: resp.headers, data: resp.data };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.toLowerCase().includes("not implement")) {
          throw new Error(
            "Le plugin HTTP natif (RawHttp) n'est pas disponible. " +
            "Reconstruisez l'APK pour activer la synchronisation."
          );
        }
        throw e;
      }
    }
    // Web/dev path — fetch() works here (no Android WebView CORS restriction)
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    const respHeaders: Record<string, string> = {};
    // Optional chaining: test mocks may omit headers; real fetch() always has it.
    resp.headers?.forEach?.((val: string, key: string) => { respHeaders[key] = val; });
    return { status: resp.status, headers: respHeaders, data: text };
  }

  /** Ensures the URL has an http(s) scheme; defaults to https. */
  normalizeUrl(url: string): string {
    const trimmed = url.trim().replace(/\/+$/, "");
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  }

  /**
   * Returns the URL without a port suffix, for use with Android's WebKit
   * CookieManager. WebKit stores cookies by domain (ignoring port), so
   * setCookie/getCookies for http://host:8069 must use http://host to work.
   */
  private cookieUrl(url: string): string {
    return this.normalizeUrl(url).replace(/:\d+$/, "");
  }

  /**
   * Validates a CapacitorHttp response and returns its parsed JSON data.
   * Throws a descriptive error for non-2xx status or non-object data.
   */
  private parseNativeResponse(resp: { status: number; data: any }, url: string): any {
    const ok = resp.status >= 200 && resp.status < 300;
    if (!ok) {
      const preview = (typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data))
        .slice(0, 200).replace(/\s+/g, " ");
      throw new Error(`HTTP ${resp.status} depuis ${url} — ${preview}`);
    }
    // CapacitorHttp may return data as a string even with responseType:'json' in some
    // Android configurations. Attempt to parse if so.
    let data = resp.data;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch {
        throw new Error(`Réponse non-JSON (HTTP ${resp.status}) de ${url} : ${data.slice(0, 200)}`);
      }
    }
    if (typeof data !== "object" || data === null) {
      throw new Error(`Réponse non-JSON (HTTP ${resp.status}) de ${url} : ${String(data).slice(0, 200)}`);
    }
    return data;
  }

  /** Session key of the older format, without the database; purged on login. */
  private legacySessionKey(creds: SyncCredentials): string | null {
    try {
      return StorageConstants.SYNC_SESSION_PREFIX + btoa(`${creds.odooUrl}|${creds.username}`);
    } catch {
      return null;
    }
  }
}
