package ca.erplibre.home.streamdeck;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Runs session closes off the calling thread. DeckSession.close() blocks
 * until its workers end, up to its own bound per session; on the main
 * thread or the shared plugin thread, closes run one after the other would
 * add up. Each close here gets its own daemon thread, and the caller waits
 * for all of them within one bound: the slowest close, not the sum.
 */
final class ParallelClose {

    private ParallelClose() { }

    /**
     * Starts each of {@code closes} on a daemon thread named {@code name},
     * then waits for them, all within {@code boundMs}; a bound of 0 returns
     * at once. Returns how many were still running at the bound. An
     * interrupt of the calling thread does not cut the wait short; it is
     * kept for the caller.
     */
    static int run(List<Runnable> closes, String name, long boundMs) {
        List<Thread> threads = new ArrayList<>();
        for (Runnable close : closes) {
            Thread t = new Thread(close, name);
            t.setDaemon(true);
            t.start();
            threads.add(t);
        }
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(boundMs);
        boolean interrupted = false;
        int running = 0;
        for (Thread t : threads) {
            long left;
            while (t.isAlive() && (left = deadline - System.nanoTime()) > 0) {
                try {
                    t.join(Math.max(1, TimeUnit.NANOSECONDS.toMillis(left)));
                } catch (InterruptedException e) {
                    interrupted = true;
                }
            }
            if (t.isAlive()) running++;
        }
        if (interrupted) Thread.currentThread().interrupt();
        return running;
    }
}
