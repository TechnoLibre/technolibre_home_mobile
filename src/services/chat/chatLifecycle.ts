import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

import { nativeTransport } from "../../plugins/chatSocketPlugin";
import type { ApplicationsChange } from "../appService";
import type { ChatService } from "./chatService";

/**
 * Ties the chat's realtime to the app state and to the application list:
 * the buses run while the app is in the foreground, are stopped when it
 * goes to the background, and start again over the new sources when an
 * application is added, edited or deleted. Realtime is native only; off a
 * native platform start() does nothing, while a deleted application's chat
 * data is still erased. The listener lives here, not in ChatService, so
 * that service builds in node without @capacitor/app.
 */
export class ChatLifecycle {
  /** Whether the app is in the foreground, as last known; false until start() reads it. */
  private active = false;
  private native = false;

  constructor(private chat: ChatService) {}

  /**
   * Follows appStateChange, then reads the present state: realtime starts
   * only when the app is active, so a cold start in the background opens
   * no socket. A state change reported before the read answers wins over
   * the read. A state that cannot be read counts as active. Call once.
   */
  async start(): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    this.native = true;
    let reported = false;
    void App.addListener("appStateChange", ({ isActive }) => {
      reported = true;
      this.follow(isActive);
    });
    let isActive = true;
    try {
      isActive = (await App.getState()).isActive;
    } catch {
      // Unknown: the app is taken as active, as at a launch from the launcher
    }
    if (!reported) this.follow(isActive);
  }

  private follow(isActive: boolean): void {
    this.active = isActive;
    if (isActive) this.startRealtime();
    else this.chat.stopRealtime();
  }

  /**
   * After a change of the application list: the buses stop, a deleted
   * application's chat data is erased (ChatService.forgetSource), and
   * realtime starts again over the sources now listed when the app is
   * active.
   */
  async applicationsChanged(change: ApplicationsChange): Promise<void> {
    this.chat.stopRealtime();
    if (change.kind === "delete" && change.configId) await this.chat.forgetSource(change.configId);
    if (this.native && this.active) this.startRealtime();
  }

  private startRealtime(): void {
    this.chat.startRealtime(nativeTransport).catch((e) => console.warn("[chat] realtime start failed:", e));
  }
}
