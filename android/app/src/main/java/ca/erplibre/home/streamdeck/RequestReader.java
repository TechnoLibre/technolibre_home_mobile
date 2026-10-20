package ca.erplibre.home.streamdeck;

/**
 * The "userequest" reader loop, free of Android types so JUnit covers it.
 * DeckSession adapts one UsbRequest on the interrupt-IN endpoint to Pipe.
 *
 * Exactly one request is ever handed to the kernel. It is queued again only
 * after a wait has returned it: usbfs copies an IN report into the buffer
 * given at submit time, and does so when the request is reaped. A second
 * submit of a request still queued leaves the kernel two URBs for one
 * buffer pointer, and the framework frees the buffer of the newest one when
 * it reaps the oldest; the next report is then written into freed memory.
 * A wait that times out therefore cancels nothing: the request stays queued
 * and the next wait is on it. An idle deck sends no report at all.
 *
 * On exit the queued request is cancelled, then reaped, and only then
 * closed, so the kernel holds no pointer into a freed request or buffer. A
 * request the kernel never gives back within DRAIN_WAITS waits is left
 * unclosed (leftQueued); closing the connection afterwards discards it.
 *
 * run() never closes the session: it returns the failure reason, and the
 * caller closes once run() has released the request.
 */
final class RequestReader {

    /** Longest wait for one completion: also how late the loop sees a close. */
    static final long WAIT_MS = 250;
    /** Waits for a cancelled request to be reaped before giving up on it. */
    static final int DRAIN_WAITS = 4;
    /** Failed waits in a row that end the reader. */
    static final int WAIT_FAILURES_TO_CLOSE = 3;
    /** Shortest interval between two onIdle notes. */
    static final long IDLE_NOTE_MS = 5000;

    static final String QUEUE_FAILED = "usb_request_queue_failed";
    static final String WAIT_FAILED = "usb_request_wait_failed";

    /** A wait that failed rather than timed out; the message is its detail. */
    static final class WaitFailed extends Exception {
        WaitFailed(String detail) { super(detail); }
    }

    /** The one IN request and the connection it is queued on. */
    interface Pipe {
        /** Queues the request with an empty buffer; false when refused. */
        boolean submit();
        /**
         * Waits at most {@code ms} for the queued request. Returns the bytes
         * it received once the kernel gave it back, empty for a cancelled or
         * zero-length completion; null when nothing completed in time.
         */
        byte[] await(long ms) throws WaitFailed;
        /** Asks the kernel to give the queued request back without data. */
        void cancel();
        /** Frees the request. Called only while nothing is queued. */
        void close();
    }

    /** The session the reader serves. */
    interface Owner {
        /** False once the session has started closing. */
        boolean isOpen();
        /** One input report, in the reader thread. */
        void onReport(byte[] data);
        /** No report for {@code msSinceData}; at most once per IDLE_NOTE_MS. */
        void onIdle(long msSinceData);
    }

    interface Clock { long now(); }

    private final Pipe pipe;
    private final Owner owner;
    private final Clock clock;
    private boolean leftQueued = false;

    RequestReader(Pipe pipe, Owner owner, Clock clock) {
        this.pipe = pipe;
        this.owner = owner;
        this.clock = clock;
    }

    /** True when run() ended with a request the kernel never gave back. */
    boolean leftQueued() { return leftQueued; }

    /**
     * Reads until the session closes or the pipe fails. Returns null in the
     * first case, the failure reason in the second. The request is released
     * on return either way.
     */
    String run() {
        boolean queued = false;
        int failuresInARow = 0;
        long lastDataAt = clock.now();
        long lastIdleNote = lastDataAt;
        String failure = null;
        try {
            while (owner.isOpen()) {
                if (!queued) {
                    if (!pipe.submit()) { failure = QUEUE_FAILED; break; }
                    queued = true;
                }
                byte[] got;
                try {
                    got = pipe.await(WAIT_MS);
                    failuresInARow = 0;
                } catch (WaitFailed e) {
                    // The request's state is unknown: it counts as queued.
                    if (++failuresInARow >= WAIT_FAILURES_TO_CLOSE) {
                        failure = WAIT_FAILED + ":" + e.getMessage();
                        break;
                    }
                    continue;
                }
                if (got != null) queued = false;
                if (!owner.isOpen()) break;
                long now = clock.now();
                if (got == null) {
                    if (now - lastIdleNote >= IDLE_NOTE_MS) {
                        owner.onIdle(now - lastDataAt);
                        lastIdleNote = now;
                    }
                    continue;
                }
                if (got.length == 0) continue;
                lastDataAt = now;
                owner.onReport(got);
            }
        } finally {
            leftQueued = queued && !drain();
            if (!leftQueued) {
                try { pipe.close(); } catch (RuntimeException ignored) { }
            }
        }
        return failure;
    }

    /** Cancels the queued request and reaps it; false if it never came back. */
    private boolean drain() {
        try { pipe.cancel(); } catch (RuntimeException ignored) { }
        for (int i = 0; i < DRAIN_WAITS; i++) {
            try {
                if (pipe.await(WAIT_MS) != null) return true;
            } catch (WaitFailed e) {
                return false;
            }
        }
        return false;
    }
}
