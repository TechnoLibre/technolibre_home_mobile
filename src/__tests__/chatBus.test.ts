import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKOFF_JITTER_MS,
  BACKOFF_MAX_MS,
  BACKOFF_START_MS,
  BUS_RETENTION_MS,
  BUS_FIRST_POLL_MS,
  ChatBus,
  type BusTransport,
} from "../services/chat/chatBus";
import { ALLOW_HTTP_KEY, InsecureHttpError } from "../services/odoo/httpPolicy";
import type { ChatSourceState } from "../models/chat";

class FakeTransport implements BusTransport {
  opened: { url: string; headers: Record<string, string> } | null = null;
  sent: any[] = [];
  closed = false;
  onOpen = () => {};
  onMessage = (_t: string) => {};
  onClose = (_c: number, _r: string) => {};
  open(url: string, headers: Record<string, string>) {
    this.opened = { url, headers };
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.closed = true;
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup(url = "https://odoo.example.org", state: Partial<ChatSourceState> = {}) {
  const transports: FakeTransport[] = [];
  const saved: number[] = [];
  const log: string[] = [];
  const st = { lastBusId: 5, busSeenAt: new Date().toISOString(), loadedAt: null, ...state } as ChatSourceState;
  const deps = {
    transport: () => {
      const t = new FakeTransport();
      transports.push(t);
      return t;
    },
    session: vi.fn(async () => ({ sessionId: "sid1", version: "18.0-7" })),
    reauth: vi.fn(async () => {}),
    state: async () => st,
    saveLast: vi.fn(async (id: number) => {
      saved.push(id);
      log.push("save" + id);
    }),
    channels: async () => ["odoo-presence-res.partner_7"],
    deliver: vi.fn(async (n: any[]) => {
      log.push("deliver" + n[n.length - 1].id);
    }),
    reload: vi.fn(async () => {
      log.push("reload");
    }),
    random: () => 0.5,
  };
  const bus = new ChatBus({ app: { url } } as any, deps);
  return { bus, deps, transports, saved, log, st };
}

async function opened(h: ReturnType<typeof setup>) {
  h.bus.start();
  await flush();
  const t = h.transports[h.transports.length - 1];
  t.onOpen();
  await flush();
  return t;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ChatBus", () => {
  it("subscribes with the saved last id and the presence channels", async () => {
    const h = setup();
    const t = await opened(h);
    expect(t.sent[0]).toEqual({
      event_name: "subscribe",
      data: { channels: ["odoo-presence-res.partner_7"], last: 5 },
    });
    expect(t.sent[1]).toEqual({
      event_name: "update_presence",
      data: { inactivity_period: 0, im_status_ids_by_model: {} },
    });
    expect(h.bus.connected).toBe(true);
  });

  it("wss url and headers from https server", async () => {
    const h = setup("https://odoo.example.org/");
    h.bus.start();
    await flush();
    const o = h.transports[0].opened!;
    expect(o.url).toBe("wss://odoo.example.org/websocket?version=18.0-7");
    expect(o.headers).toEqual({ Origin: "https://odoo.example.org", Cookie: "session_id=sid1" });
  });

  it("ws url refused unless http allowed", async () => {
    const h = setup("http://odoo.example.org:8069");
    expect(() => h.bus.start()).toThrow(InsecureHttpError);
    await flush();
    expect(h.transports.length).toBe(0);
    localStorage.setItem(ALLOW_HTTP_KEY, "true");
    h.bus.start();
    await flush();
    expect(h.transports[0].opened!.url).toBe("ws://odoo.example.org:8069/websocket?version=18.0-7");
  });

  it("frames delivered then last id saved", async () => {
    const h = setup();
    const t = await opened(h);
    t.onMessage(JSON.stringify([{ id: 6, message: { type: "a", payload: {} } }, { id: 9, message: { type: "b", payload: {} } }]));
    await flush();
    expect(h.log).toEqual(["deliver9", "save9"]);
    h.deps.deliver.mockRejectedValueOnce(new Error("boom"));
    t.onMessage(JSON.stringify([{ id: 12, message: { type: "a", payload: {} } }]));
    await flush();
    expect(h.saved).toEqual([9]);
    expect(h.bus.connected).toBe(true);
  });

  it("4001 re-authenticates then reconnects", async () => {
    const h = setup();
    const t = await opened(h);
    t.onClose(4001, "");
    await flush();
    expect(h.deps.reauth).toHaveBeenCalledTimes(1);
    expect(h.transports.length).toBe(1);
    vi.advanceTimersByTime(BACKOFF_START_MS + 0.5 * BACKOFF_JITTER_MS);
    await flush();
    expect(h.transports.length).toBe(2);
  });

  it("4001 keeps backing off when reauth throws", async () => {
    const h = setup();
    h.deps.reauth.mockRejectedValue(new Error("no"));
    const t = await opened(h);
    t.onClose(4001, "");
    await flush();
    vi.advanceTimersByTime(BACKOFF_START_MS + 0.5 * BACKOFF_JITTER_MS);
    await flush();
    expect(h.transports.length).toBe(2);
  });

  it("4002 reconnects at once", async () => {
    const h = setup();
    const t = await opened(h);
    t.onClose(4002, "");
    await flush();
    vi.advanceTimersByTime(0);
    await flush();
    expect(h.transports.length).toBe(2);
    expect(h.deps.reauth).not.toHaveBeenCalled();
  });

  it("outdated version stops", async () => {
    const h = setup();
    const t = await opened(h);
    t.onClose(1000, "OUTDATED_VERSION");
    await flush();
    vi.advanceTimersByTime(10 * BACKOFF_MAX_MS);
    await flush();
    expect(h.transports.length).toBe(1);
    expect(h.bus.stoppedReason).toBe("OUTDATED_VERSION");
  });

  it("backoff doubles to 120 s plus jitter", async () => {
    const h = setup();
    h.bus.start();
    await flush();
    const expected = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 120000, 120000];
    for (let i = 0; i < expected.length; i++) {
      const t = h.transports[h.transports.length - 1];
      t.onClose(1006, "");
      await flush();
      const delay = expected[i] + 0.5 * BACKOFF_JITTER_MS;
      vi.advanceTimersByTime(delay - 1);
      await flush();
      expect(h.transports.length).toBe(i + 1);
      vi.advanceTimersByTime(1);
      await flush();
      expect(h.transports.length).toBe(i + 2);
    }
  });

  it("reconnectNow connects at once from a long backoff, and restarts it", async () => {
    const h = setup();
    h.bus.start();
    await flush();
    for (let i = 0; i < 6; i++) {
      h.transports[h.transports.length - 1].onClose(1006, "");
      await flush();
      vi.advanceTimersByTime(BACKOFF_MAX_MS + BACKOFF_JITTER_MS);
      await flush();
    }
    const before = h.transports.length;
    h.transports[before - 1].onClose(1006, "");
    await flush();
    h.bus.reconnectNow();
    await flush();
    expect(h.transports.length).toBe(before + 1);
    // The pending delay was dropped, and the next failure waits the first step again
    h.transports[before].onClose(1006, "");
    await flush();
    vi.advanceTimersByTime(BACKOFF_START_MS + 0.5 * BACKOFF_JITTER_MS);
    await flush();
    expect(h.transports.length).toBe(before + 2);
  });

  it("reconnectNow leaves a connected or a stopped bus alone", async () => {
    const h = setup();
    await opened(h);
    h.bus.reconnectNow();
    await flush();
    expect(h.transports.length).toBe(1);
    h.bus.stop();
    h.bus.reconnectNow();
    await flush();
    expect(h.transports.length).toBe(1);
  });

  it("backoff restarts after a minute open", async () => {
    const h = setup();
    let t = await opened(h);
    t.onClose(1006, "");
    await flush();
    vi.advanceTimersByTime(BACKOFF_START_MS + 0.5 * BACKOFF_JITTER_MS);
    await flush();
    t = h.transports[1];
    t.onOpen();
    await flush();
    vi.advanceTimersByTime(60000);
    t.onClose(1006, "");
    await flush();
    vi.advanceTimersByTime(BACKOFF_START_MS + 0.5 * BACKOFF_JITTER_MS);
    await flush();
    expect(h.transports.length).toBe(3);
  });

  it("gap over bus retention reloads", async () => {
    const h = setup("https://odoo.example.org", {
      lastBusId: 40,
      busSeenAt: new Date(Date.now() - BUS_RETENTION_MS - 1000).toISOString(),
    });
    const t = await opened(h);
    expect(h.deps.reload).toHaveBeenCalledTimes(1);
    expect(t.sent[0].data.last).toBe(0);
  });

  it("resubscribe sends subscribe again with the current last id", async () => {
    const h = setup();
    const t = await opened(h);
    t.onMessage(JSON.stringify([{ id: 8, message: { type: "a", payload: {} } }]));
    await flush();
    h.bus.resubscribe();
    await flush();
    expect(t.sent[t.sent.length - 1]).toEqual({
      event_name: "subscribe",
      data: { channels: ["odoo-presence-res.partner_7"], last: 8 },
    });
  });

  it("stop closes and never reconnects", async () => {
    const h = setup();
    const t = await opened(h);
    h.bus.stop();
    expect(t.closed).toBe(true);
    expect(h.bus.connected).toBe(false);
    t.onClose(1006, "");
    await flush();
    vi.advanceTimersByTime(10 * BACKOFF_MAX_MS);
    await flush();
    expect(h.transports.length).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a failed frame holds the saved id so the next connect replays it", async () => {
    const h = setup();
    const t = await opened(h);
    const frame = (id: number) => JSON.stringify([{ id, message: { type: "a", payload: {} } }]);
    t.onMessage(frame(9));
    await flush();
    h.deps.deliver.mockRejectedValueOnce(new Error("boom"));
    t.onMessage(frame(12));
    t.onMessage(frame(13));
    await flush();
    expect(h.saved).toEqual([9]);
    h.st.lastBusId = 9;
    t.onClose(4002, "");
    await flush();
    vi.advanceTimersByTime(0);
    await flush();
    const t2 = h.transports[1];
    t2.onOpen();
    await flush();
    expect(t2.sent[0].data.last).toBe(9);
  });

  it("no last id and an old store reloads, a recent one does not", async () => {
    const old = setup("https://odoo.example.org", { lastBusId: 0, busSeenAt: null, loadedAt: new Date(Date.now() - 3600000).toISOString() });
    await opened(old);
    expect(old.deps.reload).toHaveBeenCalledTimes(1);
    const fresh = setup("https://odoo.example.org", { lastBusId: 0, busSeenAt: null, loadedAt: new Date(Date.now() - 10000).toISOString() });
    await opened(fresh);
    expect(fresh.deps.reload).not.toHaveBeenCalled();
    expect(BUS_FIRST_POLL_MS).toBe(50000);
  });

  it("two reconnects after one reload reload once", async () => {
    const h = setup("https://odoo.example.org", { lastBusId: 0, busSeenAt: null });
    let t = await opened(h);
    for (let i = 0; i < 2; i++) {
      t.onClose(4002, "");
      await flush();
      vi.advanceTimersByTime(0);
      await flush();
      t = h.transports[h.transports.length - 1];
      t.onOpen();
      await flush();
    }
    expect(h.deps.reload).toHaveBeenCalledTimes(1);
  });

  it("double start opens one transport", async () => {
    const h = setup();
    h.bus.start();
    h.bus.start();
    await flush();
    expect(h.transports.length).toBe(1);
  });

  it("stop then start during a pending session yields one transport", async () => {
    const h = setup();
    let release: (v: any) => void = () => {};
    h.deps.session.mockImplementationOnce(() => new Promise((r) => (release = r)));
    h.bus.start();
    h.bus.stop();
    h.bus.start();
    await flush();
    release({ sessionId: "old", version: "18.0-7" });
    await flush();
    expect(h.transports.length).toBe(1);
    expect(h.transports[0].opened!.headers.Cookie).toBe("session_id=sid1");
  });

  it("http turned off stops reconnects as insecure", async () => {
    localStorage.setItem(ALLOW_HTTP_KEY, "true");
    const h = setup("http://odoo.example.org");
    const t = await opened(h);
    t.onClose(1006, "");
    await flush();
    localStorage.setItem(ALLOW_HTTP_KEY, "false");
    vi.advanceTimersByTime(BACKOFF_START_MS + BACKOFF_JITTER_MS);
    await flush();
    expect(h.transports.length).toBe(1);
    expect(h.bus.stoppedReason).toBe("insecure");
  });

  it("a malformed frame is dropped without saving", async () => {
    const h = setup();
    const t = await opened(h);
    t.onMessage(JSON.stringify([{ id: "x" }]));
    t.onMessage(JSON.stringify([null]));
    await flush();
    expect(h.deps.deliver).not.toHaveBeenCalled();
    expect(h.saved).toEqual([]);
  });

  it("a stale transport close schedules nothing", async () => {
    const h = setup();
    const t = await opened(h);
    t.onClose(4002, "");
    await flush();
    vi.advanceTimersByTime(0);
    await flush();
    expect(h.transports.length).toBe(2);
    t.onClose(1006, "");
    await flush();
    vi.advanceTimersByTime(10 * BACKOFF_MAX_MS);
    await flush();
    expect(h.transports.length).toBe(2);
  });
});
