import type { DeckHealth } from "../plugins/streamDeckPlugin";

/** Hidden longer than this, the controller asks the plugin for the
 *  health of every deck when the page is visible again. A shorter hide
 *  only restores brightness and repaints. */
export const HEALTH_CHECK_AFTER_HIDDEN_MS = 5000;

/** What a resume does with the plugin's health report. */
export interface SickDeckPlan {
    /** USB device names for restartSessions({deviceNames}); empty when
     *  every deck is healthy, and then nothing is restarted. */
    deviceNames: string[];
    /** deckIds of the sick decks that have one: the resume skips their
     *  brightness restore and repaint, which deckConnected does once the
     *  restart reopens them. */
    deckIds: string[];
    /** One "<deviceName>: <sickReason>" per sick deck, for the log. */
    reasons: string[];
}

/** True when a hide of {@code hiddenForMs} calls for a health check. */
export function shouldCheckHealth(hiddenForMs: number): boolean {
    return hiddenForMs > HEALTH_CHECK_AFTER_HIDDEN_MS;
}

/**
 * The decks to restart: those the plugin reports sick, each once. The
 * verdict is the plugin's (SessionHealth.java), made from signals only it
 * holds; this side never restarts a deck on its own judgement, so a deck
 * reported healthy, an entry without a device name and a malformed report
 * all restart nothing.
 */
export function planSickRestart(
    decks: readonly DeckHealth[] | null | undefined,
): SickDeckPlan {
    const plan: SickDeckPlan = { deviceNames: [], deckIds: [], reasons: [] };
    if (!Array.isArray(decks)) return plan;
    for (const d of decks) {
        if (!d || d.sick !== true) continue;
        if (typeof d.deviceName !== "string" || d.deviceName === "") continue;
        if (plan.deviceNames.includes(d.deviceName)) continue;
        plan.deviceNames.push(d.deviceName);
        if (typeof d.deckId === "string" && d.deckId !== "") plan.deckIds.push(d.deckId);
        plan.reasons.push(`${d.deviceName}: ${d.sickReason || "sick"}`);
    }
    return plan;
}
