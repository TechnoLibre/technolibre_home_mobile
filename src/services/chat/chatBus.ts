import type { BusNotification, ChatSourceState } from "../../models/chat";
import { assertUrlAllowed } from "../odoo/httpPolicy";
import type { ChatSource } from "./chatSources";

/** Version the server expects when the session does not report one. */
export const BUS_VERSION_FALLBACK = "18.0-7";
/** Age past which the server's bus rows are gone and a catch-up proves nothing. */
export const BUS_RETENTION_MS = 24 * 3600 * 1000;
export const BACKOFF_START_MS = 1000;
export const BACKOFF_MAX_MS = 120000;
export const BACKOFF_JITTER_MS = 30000;
/** Keepalive period of the transport (the plugin sends it; the client has no timer for it). */
export const KEEPALIVE_MS = 60000;
/** Window of Odoo's `last=0` catch-up: older events are not replayed. */
export const BUS_FIRST_POLL_MS = 50000;
/** A connection open this long counts as healthy: the backoff restarts. */
const STABLE_OPEN_MS = 60000;

/**
 * One websocket, as the bus client sees it. The native plugin implements it
 * on the device, a fake in tests. The handlers are assigned by the
 * client before open(); onClose fires once per opened socket.
 */
export interface BusTransport {
  open(url: string, headers: Record<string, string>): void;
  send(text: string): void;
  close(): void;
  onOpen: () => void;
  onMessage: (text: string) => void;
  onClose: (code: number, reason: string) => void;
}

export interface ChatBusDeps {
  transport: () => BusTransport;
  session: () => Promise<{ sessionId: string; version: string }>;
  reauth: () => Promise<void>;
  state: () => Promise<ChatSourceState>;
  /** Persists the last bus id (and the time it was seen) once a frame is applied. */
  saveLast: (id: number) => Promise<void>;
  /** "odoo-presence-res.partner_<id>" of every chat correspondent; member channels are implicit. */
  channels: () => Promise<string[]>;
  deliver: (n: BusNotification[]) => Promise<void>;
  /** Reloads the whole Discuss store after a gap the bus cannot replay. */
  reload: () => Promise<void>;
  random?: () => number;
}

/**
 * Odoo 18 bus client over an abstract transport. One instance per account.
 * It connects, subscribes with the saved last id, hands each frame to
 * deliver() then persists its highest id, and reconnects by close code:
 * 1000 "OUTDATED_VERSION" stops for good, 4001 re-authenticates first,
 * 4002 reconnects at once, anything else backs off exponentially.
 */
export class ChatBus {
  /** Set when the server refused this client's version; nothing reconnects after it. */
  stoppedReason: string | null = null;
  private isConnected = false;
  private stopped = true;
  private transport: BusTransport | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private lastId = 0;
  /** Bumped by every start/stop/connect so a stale async step aborts. */
  private generation = 0;
  /** Set on the first failed frame of a socket: later frames deliver but save nothing. */
  private saveHeld = false;
  /** Time of the last reload() this instance ran, standing in for busSeenAt until a frame arrives. */
  private reloadedAt: number | null = null;
  /** Frames are applied one after the other so the saved id never goes backwards. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private src: ChatSource,
    private deps: ChatBusDeps,
  ) {}

  get connected(): boolean {
    return this.isConnected;
  }

  /** Begins connecting; throws InsecureHttpError, without opening, for ws:// while http is off. */
  start(): void {
    if (!this.stopped) return;
    this.assertSecure();
    this.stopped = false;
    this.stoppedReason = null;
    void this.connect();
  }

  /** Clears every timer and closes the socket; nothing reconnects afterwards. */
  stop(): void {
    this.stopped = true;
    this.generation++;
    this.clearTimers();
    this.detach();
    this.isConnected = false;
  }

  /** Sends subscribe again with the current channels and last id (after a channel join). */
  resubscribe(): void {
    const t = this.transport;
    if (!t || !this.isConnected) return;
    void this.deps
      .channels()
      .then((channels) => {
        if (this.transport === t) this.sendSubscribe(t, channels, this.lastId);
      })
      .catch((e) => console.warn("chat bus: resubscribe failed", e));
  }

  private baseUrl(): string {
    return this.src.app.url.replace(/\/+$/, "");
  }

  /** ws:// follows the http:// rule: the check runs on the http form of the url. */
  private assertSecure(): void {
    assertUrlAllowed(this.baseUrl());
  }

  private wsUrl(version: string): string {
    return (
      this.baseUrl().replace(/^http/i, "ws") + "/websocket?version=" + encodeURIComponent(version || BUS_VERSION_FALLBACK)
    );
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const gen = ++this.generation;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.detach();
    try {
      // Re-checked on every attempt: the http option may have been turned off since start().
      this.assertSecure();
    } catch (e) {
      console.warn("chat bus: insecure url refused", e);
      this.stopped = true;
      this.stoppedReason = "insecure";
      return;
    }
    try {
      const { sessionId, version } = await this.deps.session();
      if (this.stopped || gen !== this.generation) return;
      this.saveHeld = false;
      const t = this.deps.transport();
      this.transport = t;
      t.onOpen = () => void this.handleOpen(t);
      t.onMessage = (text) => this.handleMessage(t, text);
      t.onClose = (code, reason) => void this.handleClose(t, code, reason);
      t.open(this.wsUrl(version), {
        Origin: new URL(this.baseUrl()).origin,
        Cookie: "session_id=" + sessionId,
      });
    } catch (e) {
      console.warn("chat bus: connect failed", e);
      if (gen !== this.generation) return;
      this.scheduleReconnect(this.backoffDelay());
    }
  }

  private async handleOpen(t: BusTransport): Promise<void> {
    if (this.transport !== t || this.stopped) return;
    try {
      const state = await this.deps.state();
      let last = state.lastBusId;
      const seenAt = state.busSeenAt ? Date.parse(state.busSeenAt) : NaN;
      const loaded = state.loadedAt ? Date.parse(state.loadedAt) : NaN;
      const seen = Math.max(Number.isNaN(seenAt) ? 0 : seenAt, this.reloadedAt ?? 0);
      const now = Date.now();
      let reload = false;
      if (seen) {
        // The server dropped the rows between: the catch-up would be empty, not complete.
        reload = now - seen > BUS_RETENTION_MS;
      } else {
        // No last id seen: last=0 only replays the last seconds, so the store must be fresh.
        reload = Number.isNaN(loaded) || now - loaded > BUS_FIRST_POLL_MS;
      }
      if (reload) {
        await this.deps.reload();
        this.reloadedAt = Date.now();
        last = 0;
      }
      const channels = await this.deps.channels();
      if (this.transport !== t || this.stopped) return;
      this.lastId = last;
      this.sendSubscribe(t, channels, last);
      t.send(
        JSON.stringify({
          event_name: "update_presence",
          data: { inactivity_period: 0, im_status_ids_by_model: {} },
        }),
      );
      this.isConnected = true;
      this.stableTimer = setTimeout(() => {
        this.attempt = 0;
      }, STABLE_OPEN_MS);
    } catch (e) {
      console.warn("chat bus: opening sequence failed", e);
      if (this.transport === t) {
        t.close();
        void this.handleClose(t, 1006, "");
      }
    }
  }

  private sendSubscribe(t: BusTransport, channels: string[], last: number): void {
    t.send(JSON.stringify({ event_name: "subscribe", data: { channels, last } }));
  }

  private handleMessage(t: BusTransport, text: string): void {
    if (this.transport !== t) return;
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(frame) || !frame.length) return;
    if (!frame.every((n) => n && typeof n === "object" && Number.isInteger(n.id))) {
      console.warn("chat bus: malformed frame dropped");
      return;
    }
    const notifications = frame as BusNotification[];
    this.queue = this.queue.then(async () => {
      if (this.transport !== t) return;
      try {
        await this.deps.deliver(notifications);
        if (this.saveHeld) return;
        const top = Math.max(...notifications.map((n) => n.id));
        await this.deps.saveLast(top);
        this.lastId = Math.max(this.lastId, top);
        this.reloadedAt = null;
        this.attempt = 0;
      } catch (e) {
        // Saving stops for this socket: the next connect replays from the last good id.
        this.saveHeld = true;
        console.warn("chat bus: frame not applied", e);
      }
    });
  }

  private async handleClose(t: BusTransport, code: number, reason: string): Promise<void> {
    if (this.transport !== t) return;
    this.transport = null;
    this.isConnected = false;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
    if (this.stopped) return;
    if (code === 1000 && reason === "OUTDATED_VERSION") {
      this.stopped = true;
      this.stoppedReason = reason;
      return;
    }
    if (code === 4002) {
      this.scheduleReconnect(0);
      return;
    }
    if (code === 4001) {
      const gen = this.generation;
      try {
        await this.deps.reauth();
      } catch (e) {
        console.warn("chat bus: re-authentication failed", e);
      }
      if (this.stopped || gen !== this.generation) return;
    }
    this.scheduleReconnect(this.backoffDelay());
  }

  /** min(start * 2^n, max) + random * jitter, then n moves up. */
  private backoffDelay(): number {
    const base = Math.min(BACKOFF_START_MS * 2 ** this.attempt, BACKOFF_MAX_MS);
    this.attempt++;
    return base + (this.deps.random ?? Math.random)() * BACKOFF_JITTER_MS;
  }

  private scheduleReconnect(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.timer = null;
    this.stableTimer = null;
  }

  private detach(): void {
    const t = this.transport;
    this.transport = null;
    if (!t) return;
    try {
      t.close();
    } catch (e) {
      console.warn("chat bus: close failed", e);
    }
  }
}
