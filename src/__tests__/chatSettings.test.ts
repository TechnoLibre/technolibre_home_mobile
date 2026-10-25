import { describe, it, expect, beforeEach, vi } from "vitest";
import { CHAT_SETTINGS_KEY, DEFAULT_CHAT_SETTINGS, chatSettings, setChatSettings } from "../services/chat/chatSettings";

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
    expect(chatSettings()).toEqual({ sendRead: true, sendTyping: true });
    localStorage.setItem(CHAT_SETTINGS_KEY, "{bad");
    expect(chatSettings()).toEqual(DEFAULT_CHAT_SETTINGS);
  });

  it("round-trips", () => {
    setChatSettings({ sendRead: false, sendTyping: true });
    expect(chatSettings()).toEqual({ sendRead: false, sendTyping: true });
    expect(CHAT_SETTINGS_KEY).toBe("options.chat");
  });
});
