/**
 * Singleton ring buffer for Stream Deck plugin events. Subscribed once at
 * app boot from app.ts so every event reaches it regardless of which page
 * is mounted, then read by the diagnostic Options panel which subscribes
 * to changes — navigation no longer wipes the journal.
 */

import { t } from "../i18n";
import type { ReattachGaveUpEvent } from "../plugins/streamDeckPlugin";

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

/** Last reason of a retry that found the USB permission gone: the retry
 *  never raises the system dialog, so the permission button is the fix.
 *  The plugin gives up at that first finding, so the line counts no
 *  attempts. */
const PERMISSION_MISSING = "permission_missing";

/** Journal line of reattachGaveUp, in the user's language; names the deck
 *  by serial, or by USB device name when no serial was read. */
export function reattachGaveUpText(ev: ReattachGaveUpEvent): string {
    if (ev.reason === PERMISSION_MISSING) {
        return t("streamdeck.event_reattach_gave_up_permission", {
            deck: ev.deckId || ev.deviceName,
            button: t("streamdeck.request_permission"),
        });
    }
    return t("streamdeck.event_reattach_gave_up", {
        deck: ev.deckId || ev.deviceName,
        attempts: ev.attempts,
        reason: ev.reason,
    });
}
