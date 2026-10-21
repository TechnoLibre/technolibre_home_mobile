package ca.erplibre.home.streamdeck;

import java.util.concurrent.TimeUnit;

/**
 * Counts the USB calls made on a session's connection by threads close()
 * does not join: the plugin thread (setBrightness, reset), the main thread
 * (resetAllSessions) and every heartbeat thread, a stopped one included.
 * UsbDeviceConnection.close() frees the native device those calls use, and
 * among the connection's methods only queue, cancel and close take its
 * lock. close() therefore shuts the gate, then waits for the calls inside
 * to return before it closes the connection. Every gated call has a
 * timeout, which bounds the wait. close() never runs inside a gated call.
 */
final class UsbCallGate {

    private int inside = 0;
    private boolean shut = false;

    /** True, and the call counted, while the gate is open; the caller then
     *  calls leave() once the USB call returned. False once shut. */
    synchronized boolean enter() {
        if (shut) return false;
        inside++;
        return true;
    }

    synchronized void leave() {
        if (--inside == 0) notifyAll();
    }

    /** Refuses every later enter(). */
    synchronized void shut() {
        shut = true;
    }

    /**
     * Waits until no call is inside, at most {@code boundMs}; true when
     * none is. An interrupt of the calling thread does not cut the wait
     * short; it is kept for the caller.
     */
    synchronized boolean awaitEmpty(long boundMs) {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(boundMs);
        boolean interrupted = false;
        long left;
        while (inside > 0 && (left = deadline - System.nanoTime()) > 0) {
            try {
                wait(Math.max(1, TimeUnit.NANOSECONDS.toMillis(left)));
            } catch (InterruptedException e) {
                interrupted = true;
            }
        }
        if (interrupted) Thread.currentThread().interrupt();
        return inside == 0;
    }
}
