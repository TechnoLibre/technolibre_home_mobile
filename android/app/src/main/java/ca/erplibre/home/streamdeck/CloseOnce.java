package ca.erplibre.home.streamdeck;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Who runs a session's close, and how the other callers of close() wait
 * for it. The first caller claims the close, runs it, and calls finish()
 * once the CloseListener has run. A later caller waits for finish(), so
 * that when its own close() returns the session is unregistered and its
 * re-attach decision taken, as after the first. A worker of the session
 * does not wait: the first close() may itself be waiting for that worker.
 */
final class CloseOnce {

    private boolean started = false;
    private final CountDownLatch finished = new CountDownLatch(1);

    /** True for the first caller only, which then runs the close. */
    synchronized boolean claim() {
        if (started) return false;
        started = true;
        return true;
    }

    synchronized boolean started() { return started; }

    /** The claimed close has run, its listener included. */
    void finish() { finished.countDown(); }

    /**
     * Waits for the claimed close to finish, at most {@code boundMs}.
     * Returns at once before any claim and in one of {@code workers}; null
     * entries are skipped. False only when the bound passed with the close
     * still running. An interrupt of the calling thread does not cut the
     * wait short; it is kept for the caller.
     */
    boolean awaitFinished(List<Thread> workers, long boundMs) {
        if (!started() || workers.contains(Thread.currentThread())) return true;
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(boundMs);
        boolean interrupted = false;
        boolean done = false;
        long left;
        while (!done && (left = deadline - System.nanoTime()) > 0) {
            try {
                done = finished.await(left, TimeUnit.NANOSECONDS);
            } catch (InterruptedException e) {
                interrupted = true;
            }
        }
        if (!done) done = finished.getCount() == 0;
        if (interrupted) Thread.currentThread().interrupt();
        return done;
    }
}
