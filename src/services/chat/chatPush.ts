import { getCurrentLocale, t } from "../../i18n";
import type { ChatChannel, ChatPushRow, LockScreen } from "../../models/chat";
import { syncConfigIdFor } from "../../models/syncConfig";
import type { ChatPushNative, PushSettingsMirror } from "../../plugins/chatPushPlugin";
import { isHttpAllowed, onHttpPolicyChange } from "../odoo/httpPolicy";
import { OdooRpcError, type OdooRpcClient, type StoredSession, type SyncCredentials } from "../odoo/odooRpcClient";
import { displayNameOf } from "./chatNames";
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
] as const;

/** How long a removal waits for Odoo to unregister the account's endpoints before leaving them to native code. */
export const UNREGISTER_BOUND_MS = 5000;

const PUSH_DEVICE = "mail.push.device";

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
  /** The conversations the list shows for an account; ChatService sets its own. */
  conversations: (configId: string) => Promise<ChatChannel[]>;

  /** The end of the queue of tasks (run). */
  private chain: Promise<void> = Promise.resolve();
  /** Per account, the registration result of this foreground session ("registered" or "refused"). */
  private done = new Map<string, RegisterResult>();
  /** Per account, the session id last copied to native code in this foreground session. */
  private mirrored = new Map<string, string>();
  /** Accounts forget let go whose application row is not deleted yet: left out of the mirror. */
  private leaving = new Set<string>();
  /** The JSON of the last mirror native code accepted; an equal one is not sent again. */
  private lastMirror: string | null = null;
  private started = false;

  constructor(
    private repo: ChatRepository,
    private rpc: OdooRpcClient,
    private native: ChatPushNative | null,
    private sources: () => Promise<ChatSource[]>,
    private now: () => Date,
  ) {
    this.conversations = (configId) => repo.channels(configId);
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
    onHttpPolicyChange(() => {
      this.publish().catch((e) => console.warn("[chat push] publish failed:", messageOf(e)));
    });
    await this.run(async () => {
      await this.mirrorAllNow();
      await this.publishNow();
    });
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

  /**
   * Before the account's application is deleted. Online, its endpoint and
   * the stale ones are unregistered, all within UNREGISTER_BOUND_MS; each
   * one not unregistered then is handed to native code
   * (unsubscribe with pendingEndpoint), which unregisters it with the
   * session copy and forgets both. With none left, the subscription and
   * the session copy go at once. The row loses its ntfy, a server no
   * account is left on is removed, and the mirror without the account
   * follows.
   */
  forget(configId: string): Promise<void> {
    const native = this.native;
    if (!native) return Promise.resolve();
    return this.run(async () => {
      const row = await this.repo.pushRow(configId);
      const endpoints = withEndpoint(row.staleEndpoints, row.endpoint);
      let pending = endpoints;
      const src = (await this.sources()).find((s) => s.configId === configId);
      if (endpoints.length > 0 && src && (await this.isOnline())) pending = await this.unregisterWithin(src, endpoints);
      if (pending.length === 0) {
        await native.unsubscribe({ configId, pendingEndpoint: null });
        await native.forgetSession({ configId });
      } else {
        for (const endpoint of pending) await native.unsubscribe({ configId, pendingEndpoint: endpoint });
      }
      this.done.delete(configId);
      this.mirrored.delete(configId);
      this.leaving.add(configId);
      await this.repo.setPushRow({ configId, ...NO_NTFY, staleEndpoints: [] });
      if (row.ntfyUrl) await this.dropUnusedNtfy(row.ntfyUrl);
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
      if (await this.copySession(configId, creds, stored)) await this.publishNow();
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
   * After a load: removes the shown notifications of the account's
   * conversations whose counted unread is 0 now (read elsewhere, muted, or
   * no longer in the list), and the account's summary.
   */
  reconcileShown(configId: string): Promise<void> {
    const native = this.native;
    if (!native) return Promise.resolve();
    return this.run(async () => {
      const prefix = `chat:${configId}:`;
      const ids = (await native.shown())
        .map((s) => s.tag)
        .filter((tag) => tag.startsWith(prefix))
        .map((tag) => Number(tag.slice(prefix.length)))
        .filter((id) => Number.isInteger(id));
      if (ids.length > 0) {
        const channels = new Map((await this.conversations(configId)).map((c) => [c.channelId, c]));
        const mute = (await this.repo.sourceState(configId)).globalMuteUntil;
        const now = this.now();
        for (const id of ids) {
          const c = channels.get(id);
          const counted = c && !c.leftUnsent && !isMuted(c, now, mute) ? unreadOf(c) : 0;
          if (counted === 0) await native.clear({ configId, channelId: id });
        }
      }
      await native.clear({ configId, summary: true });
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

  private async registerNow(src: ChatSource): Promise<RegisterResult> {
    try {
      await this.copyStored(src);
    } catch (e) {
      console.warn("[chat push] session copy failed:", messageOf(e));
    }
    const known = this.done.get(src.configId);
    if (known) return known;
    const row = await this.repo.pushRow(src.configId);
    if (!row.endpoint && row.staleEndpoints.length === 0) return "none";
    if (!(await this.isOnline())) return "offline";
    try {
      await this.unregisterStale(src);
      if (!row.endpoint || !row.p256dh || !row.auth) return "none";
      const vapid = await this.rpc.callKw(src.creds, PUSH_DEVICE, "get_web_push_vapid_public_key", [], {});
      await this.rpc.callKw(src.creds, PUSH_DEVICE, "register_devices", [], {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
        vapid_public_key: vapid,
        expirationTime: null,
      });
      await this.repo.setPushRow({ configId: src.configId, vapidKey: String(vapid), registeredAt: this.now().toISOString() });
      this.done.set(src.configId, "registered");
      return "registered";
    } catch (e) {
      const result: RegisterResult = e instanceof OdooRpcError ? "refused" : "offline";
      if (result === "refused") this.done.set(src.configId, result);
      console.warn(`[chat push] registration ${result}:`, messageOf(e));
      return result;
    }
  }

  /** Unregisters the account's stale endpoints one by one, each dropped from the list once Odoo answered. */
  private async unregisterStale(src: ChatSource): Promise<void> {
    for (const endpoint of (await this.repo.pushRow(src.configId)).staleEndpoints) {
      await this.rpc.callKw(src.creds, PUSH_DEVICE, "unregister_devices", [], { endpoint });
      const now = (await this.repo.pushRow(src.configId)).staleEndpoints;
      await this.repo.setPushRow({ configId: src.configId, staleEndpoints: now.filter((e) => e !== endpoint) });
    }
  }

  /** Unregisters each endpoint in turn; returns, in order, those not unregistered within UNREGISTER_BOUND_MS. */
  private async unregisterWithin(src: ChatSource, endpoints: string[]): Promise<string[]> {
    const left = new Set(endpoints);
    const all = (async () => {
      for (const endpoint of endpoints) {
        try {
          await this.rpc.callKw(src.creds, PUSH_DEVICE, "unregister_devices", [], { endpoint });
          left.delete(endpoint);
        } catch (e) {
          console.warn("[chat push] unregister failed:", messageOf(e));
        }
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([all, new Promise<void>((resolve) => { timer = setTimeout(resolve, UNREGISTER_BOUND_MS); })]);
    clearTimeout(timer);
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

  /** Copies the account's stored session (OdooRpcClient.storedSession, no login), at levels 1 to 4. */
  private async copyStored(src: ChatSource): Promise<void> {
    if (chatSettings().notifyLevel > 4) return;
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

/** The list with the endpoint first when it is set and not in it yet. */
function withEndpoint(list: string[], endpoint: string | null): string[] {
  return endpoint && !list.includes(endpoint) ? [endpoint, ...list] : [...list];
}
