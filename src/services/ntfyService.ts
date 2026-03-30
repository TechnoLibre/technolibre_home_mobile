/**
 * Subscribes to a NTFY topic via Server-Sent Events (SSE).
 *
 * NTFY is a self-hosted push notification service. When the Odoo server
 * modifies a task, it POSTs to the configured NTFY topic. This service
 * listens for those messages while the app is in the foreground and
 * invokes the onMessage callback so the NotificationService can trigger
 * a pull sync.
 *
 * For background notifications, the user should install the NTFY Android
 * app and subscribe to the same topic.
 */
export class NtfyService {
  private source: EventSource | null = null;

  /**
   * Opens an SSE connection to ntfyUrl/ntfyTopic/sse.
   * Closes any existing connection first.
   * onMessage receives the message title (or a fallback string).
   */
  connect(ntfyUrl: string, ntfyTopic: string, onMessage: (title: string) => void): void {
    this.disconnect();
    if (!ntfyUrl || !ntfyTopic) return;

    try {
      const url = `${ntfyUrl.replace(/\/$/, "")}/${ntfyTopic}/sse`;
      this.source = new EventSource(url);

      this.source.addEventListener("message", (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data as string);
          onMessage(data.title ?? data.message ?? "Notification Odoo");
        } catch {
          onMessage("Notification Odoo");
        }
      });

      this.source.onerror = () => {
        // EventSource auto-reconnects on transient errors — no action needed.
      };
    } catch {
      // EventSource constructor can throw if the URL is invalid.
    }
  }

  /** Closes the SSE connection if open. */
  disconnect(): void {
    this.source?.close();
    this.source = null;
  }

  get isConnected(): boolean {
    return this.source !== null && this.source.readyState !== EventSource.CLOSED;
  }
}
