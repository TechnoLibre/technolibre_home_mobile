package ca.erplibre.home.streamdeck;

/**
 * Whether one session's EP0 answers class requests, and the failed ones in
 * a row; free of Android types so JUnit covers it. SessionHealth reads
 * both.
 *
 * open() sets the state from the firmware probe (see FeatureReads). Up,
 * each request gets its own timeout. Down, a request is refused at once,
 * except one every RETRY_MS, which tries with the probe's short timeout:
 * a deck slow to answer right after open, or stalled for a moment, is not
 * down for the whole session, and a deck truly down costs a caller one
 * short timeout per interval. Any request that goes through, a heartbeat
 * included, puts the pipe up again.
 *
 * Brightness and reset count their failures. The heartbeat does not: it
 * runs every HEARTBEAT_MS whether or not anything needs the pipe, a stall
 * behind a busy bus fails a few of them in a row, and the next one
 * answers. Its answers still count, as proof the pipe works. Every method
 * holds the instance monitor: the heartbeat and the plugin calls run on
 * different threads.
 */
final class ControlPipe {

    /** Shortest interval between two tries on a pipe down. */
    static final long RETRY_MS = 5000;

    private boolean up = true;
    private long lastTryAt = 0;
    private int failuresInARow = 0;

    /** The firmware probe at open answered ({@code up}) or not, at
     *  {@code now}, which starts the first retry interval. */
    synchronized void opened(boolean up, long now) {
        this.up = up;
        this.lastTryAt = now;
    }

    /**
     * The timeout for a class request at {@code now}: {@code normalMs}
     * while up; FeatureReads.PROBE_TIMEOUT_MS on a pipe down once RETRY_MS
     * passed since the last try, which this call starts; else -1, and the
     * caller refuses the request.
     */
    synchronized int timeoutFor(int normalMs, long now) {
        if (up) return normalMs;
        if (now - lastTryAt < RETRY_MS) return -1;
        lastTryAt = now;
        return FeatureReads.PROBE_TIMEOUT_MS;
    }

    /** A class request went through. True when it put a pipe down up. */
    synchronized boolean answered() {
        failuresInARow = 0;
        boolean wasDown = !up;
        up = true;
        return wasDown;
    }

    /** A class request failed; {@code counted} is false for a heartbeat. */
    synchronized void failed(boolean counted) {
        if (counted) failuresInARow++;
    }

    /** False from a probe that failed at open until a request answers. */
    synchronized boolean up() {
        return up;
    }

    /** Counted failures since the last request that went through. */
    synchronized int failuresInARow() {
        return failuresInARow;
    }
}
