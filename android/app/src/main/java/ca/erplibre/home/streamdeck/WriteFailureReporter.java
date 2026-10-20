package ca.erplibre.home.streamdeck;

import java.util.HashMap;
import java.util.Map;

/**
 * Decides which failures of fire-and-forget writes reach JS. Such a job has
 * no Promise to reject, so its failure is sent as a writeFailed event.
 *
 * A streamer offers a new frame for every key many times per second, so a
 * failing key fails again on each one. Per slot, a reason is reported when
 * it differs from the last one reported there, and a successful write to
 * that slot re-arms it; other slots succeeding leave it silent. The map
 * holds one entry per failing slot, bounded by the key count. Called from
 * the writer thread; synchronized so any other thread sees a consistent map.
 */
final class WriteFailureReporter {

    private final Map<String, String> lastReported = new HashMap<>();

    /** True when {@code reason} is news for {@code slot}. */
    synchronized boolean shouldReport(String slot, String reason) {
        return !reason.equals(lastReported.put(slot, reason));
    }

    /** A write to {@code slot} went through: its next failure is news again. */
    synchronized void succeeded(String slot) { lastReported.remove(slot); }
}
