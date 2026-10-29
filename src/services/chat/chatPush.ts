import { getCurrentLocale, t } from "../../i18n";
import type { ChatChannel, ChatMailboxItem, ChatPushRow, LockScreen } from "../../models/chat";
import { sameServerUrl, syncConfigIdFor } from "../../models/syncConfig";
import type { ChatPushNative, PushSettingsMirror } from "../../plugins/chatPushPlugin";
import { isHttpAllowed, onHttpPolicyChange } from "../odoo/httpPolicy";
import { OdooRpcError, type OdooRpcClient, type StoredSession, type SyncCredentials } from "../odoo/odooRpcClient";
import { displayNameOf } from "./chatNames";
import { effectiveLevel, levelAtLeast, type ChatModuleLevel } from "./chatModule";
import { httpUrl, type NtfyLink } from "./chatPushLink";
import type { ChatRepository } from "./chatRepository";
import { chatSettings, setChatSettings, type NotifyLevel } from "./chatSettings";
import { CHAT_MAJOR, type ChatSource } from "./chatSources";
import { isMuted, unreadOf } from "./chatUnread";

/**
 * The keys of the texts native code draws notifications with (its
 * PushStrings); each is mirrored as t("chat.push_<key>"), its `{name}`
 * placeholders left for native code to fill.
 */
export const PUSH_STRING_KEYS = [
  "new_message", "you", "new_message_server", "summary_one", "summary",
  "channel_chat", "channel_inbox", "channel_status", "channel_permanent",
  "permanent_listening_one", "permanent_listening", "permanent_waiting", "permanent_polling", "permanent_failing",
  "status_not_listening", "status_session_expired",
  "reason_unauthorized", "reason_forbidden", "reason_unreachable", "reason_odoo_unreachable", "reason_rate_limited",
  "reason_http_refused", "reason_cleartext_blocked", "reason_session_expired", "reason_protocol",
  "action_reply", "action_reply_hint", "action_mark_read", "action_mute", "action_react",
  "handoff_one", "handoff", "action_unsent",
] as const;

/**
 * How long a removal may take, its wait for the queue included, before the
 * account's endpoints are left to native code.
 */
export const UNREGISTER_BOUND_MS = 5000;

/**
 * How long one mail.push.device call may take before it counts as
 * offline: a server that never answers holds the queue, and so the other
 * accounts, no longer than this.
 */
export const PUSH_RPC_TIMEOUT_MS = 15000;

const PUSH_DEVICE = "mail.push.device";
/** Module 1.5 route that marks the partner's device of an endpoint as the app's. */
const PUSH_DEVICE_ROUTE = "/erplibre_mobile_chat/push/device";
/** The registrationError key of a device the server did not mark. */
const MARK_FAILED = "chat.push_registration_mark_failed";

/**
 * What a registration came to: Odoo holds the endpoint (registered), the
 * server could not be reached (offline, tried again at the next load),
 * Odoo answered an error (refused), or the account has no ntfy (none).
 */
export type RegisterResult = "registered" | "offline" | "refused" | "none";

/** The fields of a push row that name no ntfy, as after removeNtfy or forget. */
const NO_NTFY = {
  ntfyUrl: null, odooNtfyUrl: null, prefix: null, topic: null, endpoint: null, p256dh: null, auth: null,
  vapidKey: null, registeredAt: null,
} as const;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The JS side of the closed-app chat notifications, over the native
 * ChatPushNative (null off a native platform: every method then does
 * nothing). It keeps chat_push (ChatPushRow) and Odoo's mail.push.device
 * in step with what native code holds, and mirrors to native code what it
 * needs while the app is closed: the level, « Autoriser http », the texts,
 * each account's label, lock-screen choice and conversation names
 * (publish), and each account's Odoo session (mirrorSession).
 *
 * The methods run one at a time in call order, each from its first read
 * to its last native call. Native code forgets the session copy of an
 * account absent from the last mirror unless the copy is newer than it:
 * an account's session is copied before the mirror that includes it, and
 * a removed account is unsubscribed (its endpoint left pending when Odoo
 * could not be told) before the mirror that drops it.
 *
 * Registration (R7) runs once per account per foreground session
 * (newSession starts one): the endpoints left stale are unregistered,
 * then get_web_push_vapid_public_key and register_devices with the
 * endpoint and keys, which Odoo takes as a no-op for a device it holds and
 * as a new row after its VAPID keys were drawn again. Keys never change
 * for a topic: new keys come with a new topic, so a new endpoint.
 * Nothing secret is logged; the ntfy token and private keys never reach JS.
 */
export class ChatPush {
  /** Whether a server may answer now; ChatService sets its own. */
  isOnline: () => Promise<boolean> = async () => true;
  /**
   * The module level the account's posts use, null when none (module unseen
   * or ignored); ChatService sets its own.
   */
  moduleLevel: (configId: string) => Promise<ChatModuleLevel | null>;
  /** The conversations the list shows for an account; ChatService sets its own. */
  conversations: (configId: string) => Promise<ChatChannel[]>;

  /** The end of the queue of tasks (run). */
  private chain: Promise<void> = Promise.resolve();
  /** Per account, the registration result of this foreground session ("registered" or "refused"). */
  private done = new Map<string, RegisterResult>();
  /** Per account, the i18n key of why its last registration failed; cleared by a success. */
  private failures = new Map<string, string>();
  /** Per account, the session id last copied to native code in this foreground session. */
  private mirrored = new Map<string, string>();
  /** Accounts forget let go whose application row is not deleted yet: left out of the mirror. */
  private leaving = new Set<string>();
  /** The JSON of the last mirror native code accepted; an equal one is not sent again. */
  private lastMirror: string | null = null;
  private started = false;
  /** Stops following « Autoriser http » (set by start). */
  private stopHttp: (() => void) | null = null;

  constructor(
    private repo: ChatRepository,
    private rpc: OdooRpcClient,
    readonly native: ChatPushNative | null,
    private sources: () => Promise<ChatSource[]>,
    private now: () => Date,
  ) {
    this.conversations = (configId) => repo.channels(configId);
    this.moduleLevel = async (configId) => effectiveLevel(await repo.sourceState(configId));
  }

  /** Runs `task` once every task queued before it settled, and returns its result. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Settles once every task queued so far did. */
  idle(): Promise<void> {
    return this.chain;
  }

  /**
   * At the app's start: follows the sessions OdooRpcClient stores and the
   * « Autoriser http » option, copies the stored session of every chat
   * account (mirrorAll, no login), then publishes. Once.
   */
  async start(): Promise<void> {
    if (!this.native || this.started) return;
    this.started = true;
    this.rpc.onSessionStored = (creds, stored) => {
      this.mirrorSession(creds, stored).catch((e) => console.warn("[chat push] session copy failed:", messageOf(e)));
    };
    this.stopHttp = onHttpPolicyChange(() => {
      this.publish().catch((e) => console.warn("[chat push] publish failed:", messageOf(e)));
    });
    await this.run(async () => {
      await this.mirrorAllNow();
      await this.publishNow();
    });
  }

  /** Stops following « Autoriser http » and the stored sessions; queued tasks still run. */
  dispose(): void {
    this.stopHttp?.();
    this.stopHttp = null;
    if (this.started) this.rpc.onSessionStored = null;
  }

  /** A new foreground session: each account registers and copies its session again at its next load. */
  newSession(): void {
    this.done.clear();
    this.mirrored.clear();
  }

  /**
   * Applies a setup link to the accounts named and to every account
   * already on that ntfy under another prefix (a new link for a known
   * ntfy moves them all to new topics). The mirror goes first, so an http
   * ntfy is checked with « Autoriser http » as set. Native code checks the
   * token (setNtfy); refused, nothing is written. Each account then gets
   * its subscription, renewed when its ntfy or prefix differs, and its
   * endpoint `(odooUrl ?? url)/<topic>`; the endpoint it had before goes
   * to staleEndpoints. The accounts named take the link's Odoo-side URL,
   * the others keep theirs. Each registers at once; `registered` lists
   * those Odoo accepted. A server no account is left on is removed.
   */
  applyLink(configIds: string[], link: NtfyLink): Promise<{ ok: boolean; reason: string | null; registered: string[] }> {
    const native = this.native;
    if (!native) return Promise.resolve({ ok: false, reason: "unavailable", registered: [] });
    return this.run(async () => {
      await this.publishNow();
      const answer = await native.setNtfy({ url: link.url, token: link.token, prefix: link.prefix, cacheSeconds: link.cacheSeconds });
      if (!answer.ok) return { ok: false, reason: answer.reason, registered: [] };
      const named = new Set(configIds);
      const moved = new Set(configIds);
      const left = new Set<string>();
      for (const row of await this.repo.pushRows()) {
        if (row.ntfyUrl === link.url && row.prefix !== link.prefix) moved.add(row.configId);
      }
      const registered: string[] = [];
      for (const src of await this.liveSources()) {
        if (!moved.has(src.configId)) continue;
        try {
          const row = await this.repo.pushRow(src.configId);
          const renew = row.ntfyUrl !== link.url || row.prefix !== link.prefix;
          const sub = await native.subscribe({ configId: src.configId, ntfyUrl: link.url, renew });
          if (row.ntfyUrl && row.ntfyUrl !== link.url) left.add(row.ntfyUrl);
          await this.moveEndpoint(row, {
            ntfyUrl: link.url,
            odooNtfyUrl: named.has(src.configId) ? link.odooUrl : row.odooNtfyUrl,
            prefix: link.prefix,
            topic: sub.topic,
            p256dh: sub.p256dh,
            auth: sub.auth,
          });
          if ((await this.registerNow(src)) === "registered") registered.push(src.configId);
        } catch (e) {
          console.warn("[chat push] subscribe failed:", messageOf(e));
        }
      }
      for (const url of left) await this.dropUnusedNtfy(url);
      await this.publishNow();
      return { ok: true, reason: null, registered };
    });
  }

  /**
   * The ntfy URL as Odoo reaches it for this account (null or blank: the
   * phone's). With a subscription, the endpoint moves: the old one goes
   * stale and the account registers again at once. Throws for a value
   * that is not an http(s) URL.
   */
  setOdooUrl(configId: string, url: string | null): Promise<void> {
    if (!this.native) return Promise.resolve();
    const value = url === null || url.trim() === "" ? null : httpUrl(url);
    if (url !== null && url.trim() !== "" && value === null) return Promise.reject(new Error("Not an http(s) URL"));
    return this.run(async () => {
      const row = await this.repo.pushRow(configId);
      if (!row.ntfyUrl || !row.topic) {
        await this.repo.setPushRow({ configId, odooNtfyUrl: value });
        return;
      }
      await this.moveEndpoint(row, { ntfyUrl: row.ntfyUrl, odooNtfyUrl: value, prefix: row.prefix, topic: row.topic, p256dh: row.p256dh, auth: row.auth });
      const src = (await this.liveSources()).find((s) => s.configId === configId);
      if (src) await this.registerNow(src);
    });
  }

  /**
   * Takes the account off its ntfy: the subscription goes (native
   * unsubscribe), the endpoint joins staleEndpoints and is unregistered
   * now when Odoo answers, else at the next registration; the server
   * itself is removed once no account is left on it.
   */
  removeNtfy(configId: string): Promise<void> {
    const native = this.native;
    if (!native) return Promise.resolve();
    return this.run(async () => {
      const row = await this.repo.pushRow(configId);
      if (!row.ntfyUrl) return;
      await native.unsubscribe({ configId, pendingEndpoint: null });
      await this.repo.setPushRow({ configId, ...NO_NTFY, staleEndpoints: withEndpoint(row.staleEndpoints, row.endpoint) });
      this.done.delete(configId);
      await this.dropUnusedNtfy(row.ntfyUrl);
      const src = (await this.liveSources()).find((s) => s.configId === configId);
      if (src && (await this.isOnline())) {
        try {
          await this.unregisterStale(src);
        } catch (e) {
          console.warn("[chat push] unregister failed:", messageOf(e));
        }
      }
      await this.publishNow();
    });
  }

  /** What the account's notifications show on the lock screen; published at once. */
  setLockScreen(configId: string, mode: LockScreen): Promise<void> {
    if (!this.native) return Promise.resolve();
    return this.run(async () => {
      await this.repo.setPushRow({ configId, lockScreen: mode });
      await this.publishNow();
    });
  }

  /**
   * Saves the level and publishes it. Level 5 forgets every session copy
   * native code holds; leaving 5 copies the stored sessions again first.
   */
  setLevel(level: NotifyLevel): Promise<void> {
    return this.run(async () => {
      const before = chatSettings().notifyLevel;
      setChatSettings({ ...chatSettings(), notifyLevel: level });
      const native = this.native;
      if (!native) return;
      if (level === 5) {
        for (const src of await this.liveSources()) await native.forgetSession({ configId: src.configId });
        this.mirrored.clear();
      } else if (before === 5) {
        await this.mirrorAllNow();
      }
      await this.publishNow();
    });
  }

  /**
   * Registers the account's endpoint with Odoo, once per foreground
   * session (see the class); copies its stored session first when the
   * copy is not done yet. A failure is logged and answered, never thrown.
   */
  ensureRegistered(src: ChatSource): Promise<RegisterResult> {
    if (!this.native) return Promise.resolve("none");
    return this.run(() => this.registerNow(src));
  }

  /** The i18n key of why the account's last registration failed (offline or refused), null after a success. */
  registrationError(configId: string): string | null {
    return this.failures.get(configId) ?? null;
  }

  /**
   * Before the account's application is deleted; settles within
   * UNREGISTER_BOUND_MS of the call, the wait for the queue included.
   * Online, its endpoint and the stale ones are unregistered until that
   * bound; each one not unregistered then is handed to native code
   * (unsubscribe with pendingEndpoint), which unregisters it with the
   * session copy and forgets both. With none left, the subscription and
   * the session copy go at once. The row loses its ntfy, a server no
   * account is left on is removed, and the mirror without the account
   * follows.
   *
   * When the bound comes before the queue reached the task, the row is
   * read then and the promise settles: the caller may erase the row, and
   * the task, once it runs, starts no unregister and hands every endpoint
   * of that reading and of the row left, if any, to native code.
   */
  forget(configId: string): Promise<void> {
    const native = this.native;
    if (!native) return Promise.resolve();
    const bound = boundOf(UNREGISTER_BOUND_MS);
    let started = false;
    let early: ChatPushRow | null = null;
    const task = this.run(async () => {
      started = true;
      try {
        const row = await this.repo.pushRow(configId);
        const endpoints = withEndpoint(row.staleEndpoints, row.endpoint);
        if (early) for (const e of withEndpoint(early.staleEndpoints, early.endpoint)) if (!endpoints.includes(e)) endpoints.push(e);
        const ntfyUrl = row.ntfyUrl ?? early?.ntfyUrl ?? null;
        let pending = endpoints;
        const src = (await this.sources()).find((s) => s.configId === configId);
        if (endpoints.length > 0 && src && !bound.expired() && (await this.isOnline())) {
          pending = await this.unregisterWithin(src, endpoints, bound);
        }
        await this.letGo(native, configId, pending, ntfyUrl);
      } finally {
        bound.cancel();
      }
    });
    const handoff = bound.reached.then(async () => {
      if (started) return task;
      early = await this.repo.pushRow(configId);
    });
    return Promise.race([task, handoff]);
  }

  /** The rest of forget, inside the queue: native code lets the account go, then its row, its ntfy and the mirror. */
  private async letGo(native: ChatPushNative, configId: string, pending: string[], ntfyUrl: string | null): Promise<void> {
    if (pending.length === 0) {
      await native.unsubscribe({ configId, pendingEndpoint: null });
      await native.forgetSession({ configId });
    } else {
      for (const endpoint of pending) await native.unsubscribe({ configId, pendingEndpoint: endpoint });
    }
    this.done.delete(configId);
    this.failures.delete(configId);
    this.mirrored.delete(configId);
    this.leaving.add(configId);
    await this.repo.updatePushRow({ configId, ...NO_NTFY, staleEndpoints: [] });
    if (ntfyUrl) await this.dropUnusedNtfy(ntfyUrl);
    await this.publishNow();
  }

  /**
   * After an edit moved the account's rows from oldId to newId (the same
   * server, user and database under another spelling of the url; a rename
   * that failed leaves the row under oldId and changes nothing). Native
   * code keys everything by config id, so the old id lets go first: on
   * the same Odoo (url and database) its subscription and session copy go
   * and its endpoints stay stale for the new id to unregister; on another
   * Odoo each of them is handed to native code as pending, unregistered
   * there with the old session copy. The new id then gets a new
   * subscription and endpoint, registers at once when online, copies its
   * stored session, and the mirror follows.
   */
  rekey(oldId: string, newId: string): Promise<void> {
    const native = this.native;
    if (!native || oldId === newId) return Promise.resolve();
    return this.run(async () => {
      if ((await this.repo.pushRows()).some((r) => r.configId === oldId)) return;
      const row = await this.repo.pushRow(newId);
      const pending = sameOdoo(oldId, newId) ? [] : withEndpoint(row.staleEndpoints, row.endpoint);
      if (pending.length === 0) {
        await native.unsubscribe({ configId: oldId, pendingEndpoint: null });
        await native.forgetSession({ configId: oldId });
      } else {
        for (const endpoint of pending) await native.unsubscribe({ configId: oldId, pendingEndpoint: endpoint });
      }
      for (const id of [oldId, newId]) {
        this.done.delete(id);
        this.failures.delete(id);
        this.mirrored.delete(id);
      }
      if (row.ntfyUrl) {
        const sub = await native.subscribe({ configId: newId, ntfyUrl: row.ntfyUrl, renew: true });
        // Endpoints handed to native code are no longer this account's to unregister
        const from = pending.length > 0 ? { ...row, endpoint: null, staleEndpoints: [] } : row;
        await this.moveEndpoint(from, {
          ntfyUrl: row.ntfyUrl, odooNtfyUrl: row.odooNtfyUrl, prefix: row.prefix, topic: sub.topic, p256dh: sub.p256dh, auth: sub.auth,
        });
      }
      const src = (await this.liveSources()).find((s) => s.configId === newId);
      if (src) await this.registerNow(src);
      await this.publishNow();
    });
  }

  /**
   * After OdooRpcClient stored a new session: copied to native code when
   * it is an Odoo 18 session of a chat account and the level is 1 to 4,
   * then the mirror follows.
   */
  mirrorSession(creds: SyncCredentials, stored: StoredSession): Promise<void> {
    const native = this.native;
    if (!native) return Promise.resolve();
    return this.run(async () => {
      if (chatSettings().notifyLevel > 4 || stored.odooMajorVersion !== CHAT_MAJOR) return;
      const configId = syncConfigIdFor(creds.odooUrl, creds.username, creds.database);
      if (!(await this.liveSources()).some((s) => s.configId === configId)) return;
      if (!(await this.copySession(configId, creds, stored))) return;
      await this.publishNow();
      const src = (await this.liveSources()).find((s) => s.configId === configId);
      if (src) await this.markAppDevice(src);
    });
  }

  /** Copies the stored session of every chat account (no login), at levels 1 to 4. */
  mirrorAll(): Promise<void> {
    if (!this.native) return Promise.resolve();
    return this.run(() => this.mirrorAllNow());
  }

  /**
   * Sends the whole mirror: the level, « Autoriser http », the texts of
   * PUSH_STRING_KEYS, and per chat account its label, lock-screen choice
   * and the conversations the list shows, by displayNameOf in the app's
   * language. A mirror equal to the last one accepted is not sent again.
   */
  publish(): Promise<void> {
    if (!this.native) return Promise.resolve();
    return this.run(() => this.publishNow());
  }

  /**
   * After a load that started at loadedFrom (epoch ms): removes the shown
   * notifications of the account's conversations whose counted unread is
   * 0 now (read elsewhere, muted, or no longer in the list), its inbox
   * notifications of a record read, and its summary. A record is read
   * when the inbox counter the load read is 0, or when the phone holds its
   * items and none is left in the inbox: a record the phone never saw is
   * not known to be read. Native code removes only what was posted at or
   * before loadedFrom: a notification posted meanwhile is news the load
   * did not count.
   */
  reconcileShown(configId: string, loadedFrom: number): Promise<void> {
    const native = this.native;
    if (!native) return Promise.resolve();
    return this.run(async () => {
      const before = loadedFrom;
      const tags = (await native.shown()).map((s) => s.tag);
      const prefix = `chat:${configId}:`;
      const ids = tags
        .filter((tag) => tag.startsWith(prefix))
        .map((tag) => Number(tag.slice(prefix.length)))
        .filter((id) => Number.isInteger(id));
      const state = await this.repo.sourceState(configId);
      if (ids.length > 0) {
        const channels = new Map((await this.conversations(configId)).map((c) => [c.channelId, c]));
        const now = this.now();
        for (const id of ids) {
          const c = channels.get(id);
          const counted = c && !c.leftUnsent && !isMuted(c, now, state.globalMuteUntil) ? unreadOf(c) : 0;
          if (counted === 0) await native.clear({ configId, channelId: id, before });
        }
      }
      const records = tags.filter((tag) => tag.startsWith(`inbox:${configId}:`))
        .map((tag) => recordOf(tag.slice(`inbox:${configId}:`.length)))
        .filter((r): r is { model: string; resId: number } => r !== null);
      if (records.length > 0) {
        const waiting = await this.repo.mailboxItems(configId, "inbox");
        const read = await this.repo.mailboxItems(configId, "history");
        for (const { model, resId } of records) {
          const of = (i: ChatMailboxItem) => i.threadModel === model && i.threadId === resId;
          if (state.inboxCounter === 0 || (read.some(of) && !waiting.some(of))) {
            await native.clear({ configId, inbox: true, model, resId, before });
          }
        }
      }
      await native.clear({ configId, summary: true, before });
    });
  }

  // ─── Inside the queue ─────────────────────────────────────────────────────

  /** The chat accounts, without those forget let go. */
  private async liveSources(): Promise<ChatSource[]> {
    return (await this.sources()).filter((s) => !this.leaving.has(s.configId));
  }

  /**
   * Writes the account's new subscription and the endpoint it gives; an
   * endpoint it had before, other than the new one, goes stale, and the
   * account registers again in this session.
   */
  private async moveEndpoint(
    row: ChatPushRow,
    to: Pick<ChatPushRow, "ntfyUrl" | "odooNtfyUrl" | "prefix" | "topic" | "p256dh" | "auth">,
  ): Promise<void> {
    const endpoint = `${to.odooNtfyUrl ?? to.ntfyUrl}/${to.topic}`;
    const stale = withEndpoint(row.staleEndpoints, row.endpoint).filter((e) => e !== endpoint);
    const same = row.endpoint === endpoint;
    await this.repo.setPushRow({
      configId: row.configId,
      ...to,
      endpoint,
      staleEndpoints: stale,
      ...(same ? {} : { vapidKey: null, registeredAt: null }),
    });
    this.done.delete(row.configId);
  }

  /**
   * registerOnce between two copies of the account's stored session: the
   * second takes the session a login of the registration stored, so it
   * reaches native code before the caller's next publish.
   */
  private async registerNow(src: ChatSource): Promise<RegisterResult> {
    await this.copyQuietly(src);
    const result = await this.registerOnce(src);
    await this.copyQuietly(src);
    return result;
  }

  private async copyQuietly(src: ChatSource): Promise<void> {
    try {
      await this.copyStored(src);
    } catch (e) {
      console.warn("[chat push] session copy failed:", messageOf(e));
    }
  }

  /**
   * Registers the account's endpoint unless this session did; the row is
   * updated only while it is still stored under this id (a rename may
   * have moved it during the calls). An offline or refused result keeps
   * its reason for registrationError until a registration succeeds.
   */
  private async registerOnce(src: ChatSource): Promise<RegisterResult> {
    const known = this.done.get(src.configId);
    if (known) return known;
    const row = await this.repo.pushRow(src.configId);
    if (!row.endpoint && row.staleEndpoints.length === 0) return "none";
    if (!(await this.isOnline())) {
      this.failures.set(src.configId, "chat.push_registration_offline");
      return "offline";
    }
    try {
      await this.unregisterStale(src);
      if (!row.endpoint || !row.p256dh || !row.auth) return "none";
      const vapid = await this.kw(src, "get_web_push_vapid_public_key", {});
      await this.kw(src, "register_devices", {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
        vapid_public_key: vapid,
        expirationTime: null,
      });
      await this.repo.updatePushRow({ configId: src.configId, vapidKey: String(vapid), registeredAt: this.now().toISOString() });
      this.done.set(src.configId, "registered");
      this.failures.delete(src.configId);
      await this.markAppDevice(src);
      return "registered";
    } catch (e) {
      const result: RegisterResult = e instanceof OdooRpcError ? "refused" : "offline";
      if (result === "refused") this.done.set(src.configId, result);
      this.failures.set(src.configId, `chat.push_registration_${result}`);
      console.warn(`[chat push] registration ${result}:`, messageOf(e));
      return result;
    }
  }

  /**
   * Marks the account's device as the app's own on a module at 1.5
   * (POST /erplibre_mobile_chat/push/device), which tells the server that
   * the notification carries the actions. It does nothing below 1.5, with
   * the module ignored or without an endpoint. Odoo answering ok false
   * (no such device for this partner) or an error is kept as the
   * registration's reason (registrationError) and logged without the
   * endpoint; a success clears it. Never throws. True when marked.
   */
  async markAppDevice(src: ChatSource): Promise<boolean> {
    try {
      if (!levelAtLeast(await this.moduleLevel(src.configId), "1.5")) return false;
      const { endpoint } = await this.repo.pushRow(src.configId);
      if (!endpoint) return false;
      if (!(await this.isOnline())) return false;
      const answer = await this.withTimeout(
        this.rpc.callWithAuth(src.creds, (sessionId) =>
          this.rpc.jsonRoute(src.creds.odooUrl, sessionId, PUSH_DEVICE_ROUTE, { endpoint, quiet_while_online: false })),
        `${PUSH_DEVICE_ROUTE}`,
      );
      if (answer?.ok === true) {
        if (this.failures.get(src.configId) === MARK_FAILED) this.failures.delete(src.configId);
        return true;
      }
      this.failures.set(src.configId, MARK_FAILED);
      console.warn("[chat push] device not marked: Odoo holds no such device");
      return false;
    } catch (e) {
      this.failures.set(src.configId, MARK_FAILED);
      console.warn("[chat push] device not marked:", messageOf(e));
      return false;
    }
  }

  /** The promise's result, rejecting after PUSH_RPC_TIMEOUT_MS without one. */
  private withTimeout<T>(call: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: no answer within ${PUSH_RPC_TIMEOUT_MS} ms`)), PUSH_RPC_TIMEOUT_MS);
    });
    return Promise.race([call, late]).finally(() => clearTimeout(timer));
  }

  /** mail.push.device.<method>(**kwargs) for the account; rejects after PUSH_RPC_TIMEOUT_MS without an answer. */
  private kw(src: ChatSource, method: string, kwargs: Record<string, unknown>): Promise<any> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${PUSH_DEVICE}.${method}: no answer within ${PUSH_RPC_TIMEOUT_MS} ms`)), PUSH_RPC_TIMEOUT_MS);
    });
    return Promise.race([this.rpc.callKw(src.creds, PUSH_DEVICE, method, [], kwargs), late]).finally(() => clearTimeout(timer));
  }

  /**
   * Unregisters the account's stale endpoints one by one, each dropped from
   * the list once Odoo answered (a row moved meanwhile is not written).
   */
  private async unregisterStale(src: ChatSource): Promise<void> {
    for (const endpoint of (await this.repo.pushRow(src.configId)).staleEndpoints) {
      await this.kw(src, "unregister_devices", { endpoint });
      const now = (await this.repo.pushRow(src.configId)).staleEndpoints;
      await this.repo.updatePushRow({ configId: src.configId, staleEndpoints: now.filter((e) => e !== endpoint) });
    }
  }

  /**
   * Unregisters each endpoint in turn; returns, in order, those not
   * unregistered before the bound. At the bound no further call starts:
   * the endpoints left go to native code, and the account is on its way
   * out.
   */
  private async unregisterWithin(src: ChatSource, endpoints: string[], bound: Bound): Promise<string[]> {
    const left = new Set(endpoints);
    const all = (async () => {
      for (const endpoint of endpoints) {
        if (bound.expired()) return;
        try {
          await this.kw(src, "unregister_devices", { endpoint });
          left.delete(endpoint);
        } catch (e) {
          console.warn("[chat push] unregister failed:", messageOf(e));
        }
      }
    })();
    await Promise.race([all, bound.reached]);
    // Ended by the bound or by the last answer: either way no call starts after this
    bound.cancel();
    return endpoints.filter((e) => left.has(e));
  }

  /** Removes the ntfy from native code when no push row names it any more. */
  private async dropUnusedNtfy(url: string): Promise<void> {
    if ((await this.repo.pushRows()).some((r) => r.ntfyUrl === url)) return;
    await this.native!.removeNtfy({ url });
  }

  private async mirrorAllNow(): Promise<void> {
    if (chatSettings().notifyLevel > 4) return;
    for (const src of await this.liveSources()) {
      try {
        await this.copyStored(src);
      } catch (e) {
        console.warn("[chat push] session copy failed:", messageOf(e));
      }
    }
  }

  /**
   * Copies the account's stored session (OdooRpcClient.storedSession, no
   * login), at levels 1 to 4, while it is still a chat account: a load
   * that began before a forget or a rekey copies nothing for the id let go.
   */
  private async copyStored(src: ChatSource): Promise<void> {
    if (chatSettings().notifyLevel > 4) return;
    if (!(await this.liveSources()).some((s) => s.configId === src.configId)) return;
    const stored = await this.rpc.storedSession(src.creds);
    if (stored && stored.odooMajorVersion === CHAT_MAJOR) await this.copySession(src.configId, src.creds, stored);
  }

  /** Sends the session to native code unless this session id is the one copied last; true when sent. */
  private async copySession(configId: string, creds: SyncCredentials, stored: StoredSession): Promise<boolean> {
    if (this.mirrored.get(configId) === stored.sessionId) return false;
    await this.native!.mirrorSession({ configId, odooUrl: creds.odooUrl, database: creds.database, sessionId: stored.sessionId });
    this.mirrored.set(configId, stored.sessionId);
    return true;
  }

  private async publishNow(): Promise<void> {
    const all = await this.sources();
    // An account forget let go stays out until its application row is gone
    for (const id of [...this.leaving]) if (!all.some((s) => s.configId === id)) this.leaving.delete(id);
    const lang = getCurrentLocale();
    const accounts: PushSettingsMirror["accounts"] = [];
    for (const src of all) {
      if (this.leaving.has(src.configId)) continue;
      const { configId } = src;
      const [row, channels, membersOf, partners, state] = await Promise.all([
        this.repo.pushRow(configId),
        this.conversations(configId),
        this.repo.membersBySource(configId),
        this.repo.partners(configId),
        this.repo.sourceState(configId),
      ]);
      const byPartner = new Map(partners.map((p) => [p.partnerId, p]));
      accounts.push({
        configId,
        label: src.label,
        lockScreen: row.lockScreen,
        module: (await this.moduleLevel(configId)) ?? "",
        channels: channels.map((c) => ({
          id: c.channelId,
          name: displayNameOf(c, membersOf.get(c.channelId) ?? [], byPartner, state.selfPartnerId, lang),
          type: c.channelType,
        })),
      });
    }
    const mirror: PushSettingsMirror = {
      level: chatSettings().notifyLevel,
      allowHttp: isHttpAllowed(),
      strings: Object.fromEntries(PUSH_STRING_KEYS.map((key) => [key, t(`chat.push_${key}`)])),
      accounts,
    };
    const text = JSON.stringify(mirror);
    if (text === this.lastMirror) return;
    await this.native!.publishSettings(mirror);
    this.lastMirror = text;
  }
}

/** Whether two config ids ("url|username|database") name the same Odoo: the same server and database. */
function sameOdoo(a: string, b: string): boolean {
  const url = (id: string) => id.slice(0, id.indexOf("|"));
  const database = (id: string) => id.slice(id.lastIndexOf("|") + 1);
  return sameServerUrl(url(a), url(b)) && database(a) === database(b);
}

/** The record an inbox tag's tail "<model>:<resId>" names, or null when malformed. */
function recordOf(tail: string): { model: string; resId: number } | null {
  const at = tail.lastIndexOf(":");
  const resId = Number(tail.slice(at + 1));
  return at > 0 && Number.isInteger(resId) ? { model: tail.slice(0, at), resId } : null;
}

/**
 * A time bound: `reached` settles once `ms` passed, `expired` is true from
 * then on or once cancelled; cancel stops the timer, and `reached` then
 * never settles.
 */
interface Bound {
  reached: Promise<void>;
  expired: () => boolean;
  cancel: () => void;
}

function boundOf(ms: number): Bound {
  let over = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reached = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      over = true;
      resolve();
    }, ms);
  });
  return {
    reached,
    expired: () => over,
    cancel: () => {
      over = true;
      clearTimeout(timer);
    },
  };
}

/** The list with the endpoint first when it is set and not in it yet. */
function withEndpoint(list: string[], endpoint: string | null): string[] {
  return endpoint && !list.includes(endpoint) ? [endpoint, ...list] : [...list];
}
