import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

import { nativeTransport } from "../../plugins/chatSocketPlugin";
import type { ChatService } from "./chatService";

/**
 * Ties the chat's realtime to the app state: the buses run while the app is
 * in the foreground and are stopped when it goes to the background. Native
 * only; elsewhere start() does nothing. The listener lives here, not in
 * ChatService, so that service builds in node without @capacitor/app.
 */
export class ChatLifecycle {
  constructor(private chat: ChatService) {}

  /** Starts realtime now (the app is active at boot) and follows appStateChange. Call once. */
  start(): void {
    if (!Capacitor.isNativePlatform()) return;
    void App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) this.startRealtime();
      else this.chat.stopRealtime();
    });
    this.startRealtime();
  }

  private startRealtime(): void {
    this.chat.startRealtime(nativeTransport).catch((e) => console.warn("[chat] realtime start failed:", e));
  }
}
