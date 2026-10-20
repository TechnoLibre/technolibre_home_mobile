package ca.erplibre.home.streamdeck;

import java.util.HashMap;
import java.util.Map;

/**
 * When the plugin opens again, on its own, a deck whose session closed
 * itself while the deck stayed plugged in. Free of Android types and driven
 * by an injected clock so JUnit covers the schedule.
 *
 * A self-close — reader failure, polled_reset, failed writes (see
 * {@link #isSelfClose}) — schedules a retry after 2 s, then 4 s, then 8 s:
 * {@link #DELAYS_MS}, so three attempts at most. A reopen that fails before
 * its session registers counts as an attempt through {@link #attachFailed}.
 * Once the attempts are spent, the next failure answers GIVE_UP once, for
 * one line in the journal, and every later one answers NONE: no loop.
 *
 * A session that stayed registered for {@link #HEALTHY_MS} before closing
 * resets the count, so a deck that fails once a day keeps its three
 * retries. A close by the owner — detach (usb_lost), restartSessions,
 * app_destroyed — or {@link #forget} drops the device's state and its
 * pending retry; after {@link #stop} nothing is ever retried.
 *
 * Keys are USB device names: a deck plugged back in gets a new one, and the
 * hotplug attach handles it. Each RETRY carries a token; the retry runs
 * only if {@link #due} still accepts it, so a retry cancelled by a detach,
 * a stop or a newer retry is a no-op even if its timer already fired.
 * Every method holds the instance monitor: sessions close on their own
 * threads while the plugin schedules on another.
 */
final class ReattachPolicy {

    /** Delay before each retry; its length is the number of attempts. */
    static final long[] DELAYS_MS = {2_000L, 4_000L, 8_000L};

    /** Registered this long before closing, a session resets the count. */
    static final long HEALTHY_MS = 60_000L;

    /** Reason prefixes of a session that closed itself: the reader and
     *  the writer of DeckSession. A reason outside this list is never
     *  retried, so a new close path cannot start a loop by accident. */
    private static final String[] SELF_CLOSE_PREFIXES = {
        "usb_request_", "bulk_read_threw", "polled_", WriterStep.CLOSE_REASON + ":",
    };

    /** Close reasons of the owner: detach, restartSessions, destroy. */
    private static final String[] OWNER_CLOSE_REASONS = {
        "usb_lost", "restart_requested", "app_destroyed",
    };

    /** Monotonic milliseconds. */
    interface Clock { long nowMs(); }

    /** What the plugin does after a close or a failed reopen. */
    static final class Decision {
        enum Kind {
            /** Nothing to schedule or report. */
            NONE,
            /** Reopen after {@code delayMs}, if {@link #due} accepts {@code token}. */
            RETRY,
            /** Attempts spent: report once, schedule nothing. */
            GIVE_UP,
        }

        static final Decision NONE = new Decision(Kind.NONE, 0L, 0, 0L, null);

        final Kind kind;
        final long delayMs;
        /** RETRY: this attempt's number, from 1. GIVE_UP: the attempts made. */
        final int attempt;
        final long token;
        /** The close or attach failure that led here. */
        final String reason;

        private Decision(Kind kind, long delayMs, int attempt, long token, String reason) {
            this.kind = kind;
            this.delayMs = delayMs;
            this.attempt = attempt;
            this.token = token;
            this.reason = reason;
        }
    }

    private static final class State {
        int attempts = 0;
        boolean gaveUp = false;
        /** Clock time of the last registration, -1 while no session is. */
        long registeredAt = -1L;
        /** Token of the retry waiting for its timer, 0 when none. */
        long pending = 0L;
    }

    private final Clock clock;
    private final Map<String, State> states = new HashMap<>();
    private long lastToken = 0L;
    private boolean stopped = false;

    ReattachPolicy(Clock clock) { this.clock = clock; }

    /** True for a close by the session itself, the only kind retried. */
    static boolean isSelfClose(String reason) {
        if (reason == null) return false;
        for (String p : SELF_CLOSE_PREFIXES) if (reason.startsWith(p)) return true;
        return false;
    }

    private static boolean isOwnerClose(String reason) {
        for (String r : OWNER_CLOSE_REASONS) if (r.equals(reason)) return true;
        return false;
    }

    /** A session on {@code deviceName} registered: the healthy period
     *  starts, and a retry still waiting has nothing left to open. */
    synchronized void registered(String deviceName) {
        if (stopped) return;
        State s = states.get(deviceName);
        if (s == null) {
            s = new State();
            states.put(deviceName, s);
        }
        s.registeredAt = clock.nowMs();
        s.pending = 0L;
    }

    /** The session on {@code deviceName} closed with {@code reason}. */
    synchronized Decision closed(String deviceName, String reason) {
        if (stopped) return Decision.NONE;
        if (isOwnerClose(reason)) {
            states.remove(deviceName);
            return Decision.NONE;
        }
        if (!isSelfClose(reason)) return Decision.NONE;
        State s = states.get(deviceName);
        if (s == null) {
            s = new State();
            states.put(deviceName, s);
        }
        if (s.registeredAt >= 0 && clock.nowMs() - s.registeredAt >= HEALTHY_MS) {
            s.attempts = 0;
            s.gaveUp = false;
        }
        s.registeredAt = -1L;
        return next(s, reason);
    }

    /** A reopen of {@code deviceName} failed before its session
     *  registered. Counts only within a retry sequence: a hotplug or
     *  manual attach that fails is not retried. */
    synchronized Decision attachFailed(String deviceName, String reason) {
        if (stopped) return Decision.NONE;
        State s = states.get(deviceName);
        if (s == null || s.attempts == 0) return Decision.NONE;
        return next(s, reason);
    }

    private Decision next(State s, String reason) {
        if (s.attempts < DELAYS_MS.length) {
            long delay = DELAYS_MS[s.attempts];
            s.attempts++;
            s.pending = ++lastToken;
            return new Decision(Decision.Kind.RETRY, delay, s.attempts, s.pending, reason);
        }
        s.pending = 0L;
        if (s.gaveUp) return Decision.NONE;
        s.gaveUp = true;
        return new Decision(Decision.Kind.GIVE_UP, 0L, s.attempts, 0L, reason);
    }

    /** True once for the retry {@code token} of {@code deviceName}, if it
     *  is still the pending one; the caller then reopens the deck. */
    synchronized boolean due(String deviceName, long token) {
        if (stopped || token == 0L) return false;
        State s = states.get(deviceName);
        if (s == null || s.pending != token) return false;
        s.pending = 0L;
        return true;
    }

    /** Drop the state and pending retry of {@code deviceName}: detached. */
    synchronized void forget(String deviceName) { states.remove(deviceName); }

    /** Drop every device's state: the owner reopened the decks by hand. */
    synchronized void forgetAll() { states.clear(); }

    /** The plugin is going away: no retry is due ever again. */
    synchronized void stop() {
        stopped = true;
        states.clear();
    }
}
