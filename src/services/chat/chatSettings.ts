/** localStorage key of the chat settings. */
export const CHAT_SETTINGS_KEY = "options.chat";

/**
 * What the chat tells the server about the user: sendRead marks
 * conversations read and fetched, sendTyping announces typing. Posting a
 * message marks its conversation read whatever sendRead holds.
 */
export interface ChatSettings {
  sendRead: boolean;
  sendTyping: boolean;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = { sendRead: true, sendTyping: true };

/** The settings stored, or the defaults; a missing key counts as on, unreadable storage as the defaults. */
export function chatSettings(): ChatSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAT_SETTINGS_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return DEFAULT_CHAT_SETTINGS;
    return {
      sendRead: raw.sendRead !== false,
      sendTyping: raw.sendTyping !== false,
    };
  } catch {
    return DEFAULT_CHAT_SETTINGS;
  }
}

export function setChatSettings(settings: ChatSettings): void {
  try {
    localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Not kept: the defaults apply next time
  }
}
