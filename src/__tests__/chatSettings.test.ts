import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  CHAT_SETTINGS_KEY, DEFAULT_CACHE_LIMIT_MB, DEFAULT_CHAT_SETTINGS, chatSettings, setChatSettings,
} from "../services/chat/chatSettings";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => { items.set(k, String(v)); },
    removeItem: (k: string) => { items.delete(k); },
  };
}

describe("chatSettings", () => {
  beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));

  it("defaults when missing or unreadable", () => {
    expect(chatSettings()).toEqual({
      sendRead: true, sendTyping: true, cachePurge: false, cacheLimitMb: 2048, askCompress: false,
      listOrder: "on_top_first", notifyLevel: 3,
      climbAuto: true, climbOneBelow: 30, climbTwoBelow: 15, browserMode: "wait",
    });
    localStorage.setItem(CHAT_SETTINGS_KEY, "{bad");
    expect(chatSettings()).toEqual(DEFAULT_CHAT_SETTINGS);
  });

  it("round-trips", () => {
    const settings = { sendRead: false, sendTyping: true, cachePurge: true, cacheLimitMb: 512, askCompress: true, listOrder: "unread_first" as const, notifyLevel: 1 as const,
      climbAuto: false, climbOneBelow: 0 as const, climbTwoBelow: 50 as const, browserMode: "quiet" as const,
    };
    setChatSettings(settings);
    expect(chatSettings()).toEqual(settings);
    expect(CHAT_SETTINGS_KEY).toBe("options.chat");
  });

  it("cache settings: purge and compress off unless set, a bad limit reads as the default", () => {
    localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify({ sendRead: false }));
    expect(chatSettings()).toMatchObject({ cachePurge: false, cacheLimitMb: DEFAULT_CACHE_LIMIT_MB, askCompress: false });
    for (const bad of [0, -5, "x", null, "Infinity"]) {
      localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify({ cacheLimitMb: bad }));
      expect(chatSettings().cacheLimitMb).toBe(2048);
    }
    localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify({ cacheLimitMb: "300" }));
    expect(chatSettings().cacheLimitMb).toBe(300);
  });

  it("a stored unknown order reads as on_top_first", () => {
    for (const bad of ["pinned", 3, null, ""]) {
      localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify({ listOrder: bad }));
      expect(chatSettings().listOrder).toBe("on_top_first");
    }
    localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify({ listOrder: "unread_first" }));
    expect(chatSettings().listOrder).toBe("unread_first");
  });

  it("the notification level reads 1 to 5, anything else as 3", () => {
    for (const bad of [0, 6, 2.5, "2", null, "x"]) {
      localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify({ notifyLevel: bad }));
      expect(chatSettings().notifyLevel).toBe(3);
    }
    for (const level of [1, 2, 3, 4, 5]) {
      localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify({ notifyLevel: level }));
      expect(chatSettings().notifyLevel).toBe(level);
    }
  });

  it("the phone push settings default and validate", () => {
    localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify({ sendRead: false }));
    expect(chatSettings()).toMatchObject({ climbAuto: true, climbOneBelow: 30, climbTwoBelow: 15, browserMode: "wait" });
    for (const bad of [5, 25, 60, -10, 2.5, "30", null, "x"]) {
      localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify({ climbOneBelow: bad, climbTwoBelow: bad }));
      expect(chatSettings()).toMatchObject({ climbOneBelow: 30, climbTwoBelow: 15 });
    }
    for (const threshold of [0, 10, 15, 20, 30, 40, 50]) {
      localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify({ climbOneBelow: threshold, climbTwoBelow: threshold }));
      expect(chatSettings()).toMatchObject({ climbOneBelow: threshold, climbTwoBelow: threshold });
    }
    for (const bad of ["silent", "", 1, null, "RING"]) {
      localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify({ browserMode: bad }));
      expect(chatSettings().browserMode).toBe("wait");
    }
    for (const mode of ["ring", "wait", "quiet"]) {
      localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify({ browserMode: mode }));
      expect(chatSettings().browserMode).toBe(mode);
    }
    // Only false turns the climb off: a missing or malformed value keeps it on
    for (const [stored, auto] of [[false, false], [true, true], [0, true], ["false", true]] as const) {
      localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify({ climbAuto: stored }));
      expect(chatSettings().climbAuto).toBe(auto);
    }
  });
});
