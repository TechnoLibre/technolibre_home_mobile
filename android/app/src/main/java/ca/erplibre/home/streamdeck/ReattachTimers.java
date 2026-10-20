package ca.erplibre.home.streamdeck;

import java.util.HashMap;
import java.util.Map;

/**
 * The timer of each waiting retry, by USB device name, tagged with the
 * retry's {@link ReattachPolicy} token. Tokens only grow, so the larger
 * one is the newer retry, which is the one the policy holds as pending: a
 * schedule replaces an older timer and never a newer one, whatever order
 * the decisions of two threads arrive in. Nothing here cancels on a
 * registration: ReattachPolicy.registered clears the pending token and
 * {@link ReattachPolicy#due} turns its timer into a no-op. Free of Android
 * types; every method holds the instance monitor.
 */
final class ReattachTimers {

    /** A started timer. */
    interface Timer { void cancel(); }

    /** Starts {@code task} after {@code delayMs}; null when it cannot. */
    interface Scheduler { Timer schedule(Runnable task, long delayMs); }

    private static final class Entry {
        final long token;
        final Timer timer;
        Entry(long token, Timer timer) { this.token = token; this.timer = timer; }
    }

    private final Scheduler scheduler;
    private final Map<String, Entry> waiting = new HashMap<>();

    ReattachTimers(Scheduler scheduler) { this.scheduler = scheduler; }

    /** Start the timer of retry {@code token}, cancelling an older one.
     *  False, starting nothing, when a newer retry waits already or the
     *  scheduler refuses. */
    synchronized boolean schedule(String name, long token, long delayMs, Runnable task) {
        Entry prev = waiting.get(name);
        if (prev != null && prev.token > token) return false;
        Timer timer = scheduler.schedule(task, delayMs);
        if (timer == null) return false;
        if (prev != null) prev.timer.cancel();
        waiting.put(name, new Entry(token, timer));
        return true;
    }

    /** The timer of retry {@code token} fired: drop it, unless a newer
     *  one took its place. */
    synchronized void fired(String name, long token) {
        Entry e = waiting.get(name);
        if (e != null && e.token == token) waiting.remove(name);
    }

    /** Cancel the timer waiting for {@code name}, if any. */
    synchronized void cancel(String name) {
        Entry e = waiting.remove(name);
        if (e != null) e.timer.cancel();
    }

    /** Cancel every waiting timer. */
    synchronized void cancelAll() {
        for (Entry e : waiting.values()) e.timer.cancel();
        waiting.clear();
    }
}
