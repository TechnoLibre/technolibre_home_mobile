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
 * The owner's close() calls wake() from its own thread once isOpen() reads
 * false: the cancel gives the queued request back at once, empty, and the
 * loop leaves with nothing queued instead of after its WAIT_MS. A wake
 * that lands between two waits cancels nothing, and the loop then sees the
 * close within WAIT_MS. wake() and the release of the request share a
 * lock, and a wake after the release does nothing: UsbRequest.cancel reads
 * its native pointer without the request's own lock.
 *
 * On exit the queued request is cancelled, then reaped, and only then
 * closed, so the kernel holds no pointer into a freed request or buffer. A
 * wait that fails, as on a device gone, is followed by a reap that does not
 * wait. A request the kernel never gives back is left unclosed
 * (leftQueued): its owner closes it once the connection is closed, which
 * discards it in the kernel.
 *
 * run() never closes the session: it returns the failure reason, and the
 * caller closes once run() has released the request.
 */
final class RequestReader {

    /** Longest wait for one completion: also how late the loop sees a
     *  close that wake() missed. */
    static final long WAIT_MS = 250;
    /** Waits for a cancelled request to be reaped before giving up on it. */
    static final int DRAIN_WAITS = 4;
    /** Failed waits in a row that end the reader. */
    static final int WAIT_FAILURES_TO_CLOSE = 3;
    /** Shortest interval between two onIdle notes. */
    static final long IDLE_NOTE_MS = 5000;
    /**
     * Empty completions within EMPTY_BURST_MS that end the reader. The Java
     * API hands back a request that ended in error (halted endpoint,
     * protocol error) as an empty completion without its status; a deck
     * sends no empty report, so a burst of them is a pipe that fails every
     * request at once, and resubmitting it would spin a core forever.
     */
    static final int EMPTY_BURST = 50;
    static final long EMPTY_BURST_MS = 1000;

    static final String QUEUE_FAILED = "usb_request_queue_failed";
    static final String WAIT_FAILED = "usb_request_wait_failed";
    static final String EMPTY_FAILED = "usb_request_empty_completions";

    /** A wait that failed rather than timed out; the message is its detail. */
    static final class WaitFailed extends Exception {
        /** The wait returned no request and raised nothing. */
        final boolean nullReturn;
        WaitFailed(String detail) { this(detail, false); }
        private WaitFailed(String detail, boolean nullReturn) {
            super(detail);
            this.nullReturn = nullReturn;
        }
        /** requestWait returned null. */
        static WaitFailed nullReturn() { return new WaitFailed("null", true); }
    }

    /** The one IN request and the connection it is queued on. */
    interface Pipe {
        /** Queues the request with an empty buffer; false when refused. */
        boolean submit();
        /**
         * Waits at most {@code ms} for the queued request. Returns the bytes
         * it received once the kernel gave it back, empty for a cancelled or
         * zero-length completion; null when nothing completed in time. A
         * null from requestWait is WaitFailed.nullReturn(), which the reader
         * classifies by how long the wait took.
         */
        byte[] await(long ms) throws WaitFailed;
        /**
         * Takes the queued request back if the kernel has completed it,
         * without waiting; true when it did.
         */
        boolean reapNow();
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

    /** Milliseconds on a monotonic clock. */
    interface Clock { long now(); }

    private final Pipe pipe;
    private final Owner owner;
    private final Clock clock;
    private boolean leftQueued = false;
    /** Guards released against wake(). */
    private final Object wakeLock = new Object();
    /** Set once run() no longer owns a request wake() may cancel. */
    private boolean released = false;

    RequestReader(Pipe pipe, Owner owner, Clock clock) {
        this.pipe = pipe;
        this.owner = owner;
        this.clock = clock;
    }

    /**
     * Cancels the queued request so that the wait in progress returns at
     * once. Called by the owner from another thread, after isOpen() turned
     * false; does nothing once run() has released the request.
     */
    void wake() {
        synchronized (wakeLock) {
            if (released) return;
            try { pipe.cancel(); } catch (RuntimeException ignored) { }
        }
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
        int empties = 0;
        long emptiesSince = 0;
        String failure = null;
        try {
            while (owner.isOpen()) {
                if (!queued) {
                    if (!pipe.submit()) { failure = QUEUE_FAILED; break; }
                    queued = true;
                }
                byte[] got;
                try {
                    got = await(WAIT_MS);
                    failuresInARow = 0;
                } catch (WaitFailed e) {
                    // The request is still queued. requestWait(long) fails
                    // before any reap (poll or reap refused, null), or after
                    // one only in dequeue's buffer update, which cannot
                    // overflow: submit queues the whole remaining buffer.
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
                if (got.length == 0) {
                    if (empties == 0 || now - emptiesSince >= EMPTY_BURST_MS) {
                        empties = 0;
                        emptiesSince = now;
                    }
                    if (++empties >= EMPTY_BURST) { failure = EMPTY_FAILED; break; }
                    continue;
                }
                empties = 0;
                lastDataAt = now;
                owner.onReport(got);
            }
        } finally {
            leftQueued = queued && !drain();
            // A request left queued is the owner's to free from now on.
            synchronized (wakeLock) { released = true; }
            if (!leftQueued) {
                try { pipe.close(); } catch (RuntimeException ignored) { }
            }
        }
        return failure;
    }

    /**
     * pipe.await, where a null return counts as a timeout once at least 90 %
     * of the wait has passed. requestWait(long) reports a timeout by
     * TimeoutException only when the native wait sets ETIMEDOUT; a pipe
     * error ends the wait early, so the elapsed time tells the two apart.
     */
    private byte[] await(long ms) throws WaitFailed {
        long start = clock.now();
        try {
            return pipe.await(ms);
        } catch (WaitFailed e) {
            if (e.nullReturn && (clock.now() - start) * 10 >= ms * 9) return null;
            throw e;
        }
    }

    /** Cancels the queued request and reaps it; false if it never came back. */
    private boolean drain() {
        try { pipe.cancel(); } catch (RuntimeException ignored) { }
        for (int i = 0; i < DRAIN_WAITS; i++) {
            try {
                if (await(WAIT_MS) != null) return true;
            } catch (WaitFailed e) {
                try { return pipe.reapNow(); } catch (RuntimeException ignored) { return false; }
            }
        }
        return false;
    }
}
