import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

import { nativeTransport } from "../../plugins/chatSocketPlugin";
import type { AppService, ApplicationsChange } from "../appService";
import type { ChatService } from "./chatService";

/**
 * Ties the chat's realtime to the app state and to the application list:
 * the buses run while the app is in the foreground and are stopped when it
 * goes to the background. Coming to the foreground, at the launch too, also
 * lets the attachment cache run its due purge and starts a new session of
 * the closed-app notifications (each account registers again at its next
 * load); the start begins them (ChatPush.start). The bus of an application
 * that is added, edited or deleted stops and starts again on its own, the
 * others left running. Realtime is native only; off a native platform
 * start() does nothing, while a deleted application's chat data is still
 * erased. The listener lives here, not in ChatService, so that service
 * builds in node without @capacitor/app.
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
    this.chat.push.start().catch((e) => console.warn("[chat] push start failed:", e instanceof Error ? e.message : e));
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
    if (isActive) {
      this.chat.push.newSession();
      this.startRealtime();
      this.chat.attachments?.maybePurge().catch((e) => console.warn("[chat] cache purge failed:", e));
    } else this.chat.stopRealtime();
  }

  /**
   * Hooks the chat to the application list: each change reaches
   * applicationsChanged; an edit that renames the account holds its
   * uploads while the rows move, then the closed-app notifications move
   * to the new id (ChatPush.rekey, queued, not awaited, also when resuming
   * fails); a delete, or an edit to another login, database or server,
   * lets them go (ChatPush.forget) while the application still holds its
   * credentials.
   */
  followApplications(apps: AppService): void {
    apps.onChanged = (change) => this.applicationsChanged(change);
    apps.beforeRename = (oldConfigId, newConfigId) => this.chat.pauseUploads(oldConfigId, newConfigId);
    apps.afterRename = async (oldConfigId, newConfigId) => {
      try {
        await this.chat.resumeUploads(oldConfigId, newConfigId);
      } finally {
        this.chat.push.rekey(oldConfigId, newConfigId).catch((e) => console.warn("[chat] push rekey failed:", e instanceof Error ? e.message : e));
      }
    };
    apps.beforeDelete = (configId) => this.chat.push.forget(configId);
  }

  /**
   * After a change of the application list: a change that leaves the
   * connection as it was (realtimeRelevant false) does nothing. Otherwise
   * the bus of the account stops (the one it had before an edit that
   * renamed it), a deleted application's chat data is erased
   * (ChatService.forgetSource), and the bus of the account starts again
   * when the app is active.
   */
  async applicationsChanged(change: ApplicationsChange): Promise<void> {
    if (!change.realtimeRelevant) return;
    const { kind, configId, previousConfigId } = change;
    if (kind === "delete") {
      if (configId) await this.chat.forgetSource(configId);
      return;
    }
    const before = previousConfigId ?? configId;
    if (before && kind === "edit") this.chat.stopSourceRealtime(before);
    if (configId && this.native && this.active) this.startSource(configId);
  }

  private startSource(configId: string): void {
    this.chat.startSourceRealtime(configId).catch((e) => console.warn("[chat] realtime start failed:", e));
  }

  private startRealtime(): void {
    this.chat.startRealtime(nativeTransport).catch((e) => console.warn("[chat] realtime start failed:", e));
  }
}
