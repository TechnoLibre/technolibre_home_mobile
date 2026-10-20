package ca.erplibre.home.streamdeck;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Ends a session's worker threads before the USB connection they use is
 * released. UsbDeviceConnection.close() frees the native device that a
 * worker blocked in requestWait, bulkTransfer or controlTransfer still
 * reads, so close() waits here first. Every native call of the workers has
 * a timeout, which bounds the wait.
 */
final class WorkerShutdown {

    private WorkerShutdown() { }

    /**
     * Interrupts each thread but the calling one, then waits for them to
     * end, all within {@code boundMs}. The calling thread is skipped: a
     * worker that closes its own session is not inside a USB call. Null
     * entries are skipped. Returns the threads still alive at the bound.
     * An interrupt of the calling thread does not cut the wait short; it is
     * kept for the caller.
     */
    static List<Thread> stop(List<Thread> threads, long boundMs) {
        Thread self = Thread.currentThread();
        for (Thread t : threads) {
            if (t != null && t != self) t.interrupt();
        }
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(boundMs);
        boolean interrupted = false;
        List<Thread> alive = new ArrayList<>();
        for (Thread t : threads) {
            if (t == null || t == self) continue;
            long left;
            while (t.isAlive() && (left = deadline - System.nanoTime()) > 0) {
                try {
                    t.join(Math.max(1, TimeUnit.NANOSECONDS.toMillis(left)));
                } catch (InterruptedException e) {
                    interrupted = true;
                }
            }
            if (t.isAlive()) alive.add(t);
        }
        if (interrupted) self.interrupt();
        return alive;
    }
}
