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
 *
 * Supports optional Bearer token authentication for private NTFY topics.
 */
export class NtfyService {
  private abortController: AbortController | null = null;
  private _isConnected = false;

  /**
   * Opens an SSE connection to ntfyUrl/ntfyTopic/sse.
   * Closes any existing connection first.
   * If ntfyToken is provided, uses Bearer token authentication via fetch.
   * Otherwise falls back to unauthenticated EventSource.
   */
  connect(ntfyUrl: string, ntfyTopic: string, onMessage: (title: string) => void, ntfyToken?: string): void {
    this.disconnect();
    if (!ntfyUrl || !ntfyTopic) return;

    const url = `${ntfyUrl.replace(/\/$/, "")}/${ntfyTopic}/sse`;

    if (ntfyToken) {
      this.connectWithAuth(url, ntfyToken, onMessage);
    } else {
      this.connectWithEventSource(url, onMessage);
    }
  }

  private connectWithAuth(url: string, token: string, onMessage: (title: string) => void): void {
    this.abortController = new AbortController();
    this._isConnected = true;

    const doFetch = async () => {
      try {
        const response = await fetch(url, {
          headers: { "Authorization": `Bearer ${token}` },
          signal: this.abortController!.signal,
        });

        if (!response.ok || !response.body) {
          this._isConnected = false;
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            try {
              const data = JSON.parse(line.slice(5).trim());
              onMessage(data.title ?? data.message ?? "Notification Odoo");
            } catch {
              // Skip malformed JSON lines
            }
          }
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
      } finally {
        this._isConnected = false;
      }
    };

    doFetch();
  }

  private connectWithEventSource(url: string, onMessage: (title: string) => void): void {
    this.abortController = new AbortController();
    const source = new EventSource(url);
    this._isConnected = true;

    source.addEventListener("message", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string);
        onMessage(data.title ?? data.message ?? "Notification Odoo");
      } catch {
        onMessage("Notification Odoo");
      }
    });

    source.onerror = () => {
      // EventSource auto-reconnects on transient errors — no action needed.
    };

    // Store reference for cleanup
    this.abortController.signal.addEventListener("abort", () => {
      source.close();
      this._isConnected = false;
    });
  }

  /** Closes the SSE connection if open. */
  disconnect(): void {
    this.abortController?.abort();
    this.abortController = null;
    this._isConnected = false;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }
}
