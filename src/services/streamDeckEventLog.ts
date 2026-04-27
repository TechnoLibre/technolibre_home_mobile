/**
 * Singleton ring buffer for Stream Deck plugin events. Subscribed once at
 * app boot from app.ts so every event reaches it regardless of which page
 * is mounted, then read by the diagnostic Options panel which subscribes
 * to changes — navigation no longer wipes the journal.
 */

export interface StreamDeckEventLogEntry {
    ts: string;
    text: string;
}

const MAX_ENTRIES = 500;

class StreamDeckEventLog {
    private entries: StreamDeckEventLogEntry[] = [];
    private listeners = new Set<() => void>();

    add(text: string): void {
        const ts = new Date().toLocaleTimeString();
        this.entries.unshift({ ts, text });
        if (this.entries.length > MAX_ENTRIES) {
            this.entries.length = MAX_ENTRIES;
        }
        for (const fn of this.listeners) {
            try { fn(); } catch { /* listener crashes don't break logging */ }
        }
    }

    /** Returns a snapshot — safe to render from. */
    getAll(): StreamDeckEventLogEntry[] {
        return this.entries.slice();
    }

    clear(): void {
        this.entries = [];
        for (const fn of this.listeners) {
            try { fn(); } catch {}
        }
    }

    subscribe(fn: () => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
}

export const streamDeckEventLog = new StreamDeckEventLog();
