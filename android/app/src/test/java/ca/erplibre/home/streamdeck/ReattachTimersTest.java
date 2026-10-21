package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

public class ReattachTimersTest {

    private static final String DEV = "/dev/bus/usb/001/002";

    /** A timer the test never fires; it records its cancellation. */
    private static final class FakeTimer implements ReattachTimers.Timer {
        final long delayMs;
        boolean cancelled = false;
        FakeTimer(long delayMs) { this.delayMs = delayMs; }
        @Override public void cancel() { cancelled = true; }
    }

    private final List<FakeTimer> started = new ArrayList<>();
    private final ReattachTimers timers = new ReattachTimers((task, delayMs) -> {
        FakeTimer t = new FakeTimer(delayMs);
        started.add(t);
        return t;
    });

    private static final Runnable NOOP = () -> { };

    @Test
    public void a_newer_retry_replaces_the_older_timer() {
        assertTrue(timers.schedule(DEV, 1L, 2_000L, NOOP));
        assertTrue(timers.schedule(DEV, 2L, 4_000L, NOOP));
        assertEquals(2, started.size());
        assertTrue(started.get(0).cancelled);
        assertFalse(started.get(1).cancelled);
    }

    @Test
    public void an_older_retry_scheduled_late_leaves_the_newer_timer() {
        // Two decisions for one deck, from two threads, reach the timer
        // out of order: the newer one is the policy's pending retry.
        assertTrue(timers.schedule(DEV, 2L, 4_000L, NOOP));
        assertFalse(timers.schedule(DEV, 1L, 2_000L, NOOP));
        assertEquals(1, started.size());
        assertFalse(started.get(0).cancelled);
    }

    @Test
    public void a_stale_timer_firing_keeps_the_newer_one() {
        timers.schedule(DEV, 1L, 2_000L, NOOP);
        timers.schedule(DEV, 2L, 4_000L, NOOP);
        timers.fired(DEV, 1L);
        timers.cancel(DEV);
        assertTrue(started.get(1).cancelled);
    }

    @Test
    public void cancel_and_cancel_all_stop_every_waiting_timer() {
        timers.schedule(DEV, 1L, 2_000L, NOOP);
        timers.schedule("/dev/bus/usb/001/003", 2L, 2_000L, NOOP);
        timers.cancel(DEV);
        assertTrue(started.get(0).cancelled);
        assertFalse(started.get(1).cancelled);
        timers.cancelAll();
        assertTrue(started.get(1).cancelled);
    }

    @Test
    public void a_scheduler_that_refuses_schedules_nothing() {
        ReattachTimers closed = new ReattachTimers((task, delayMs) -> null);
        assertFalse(closed.schedule(DEV, 1L, 2_000L, NOOP));
    }
}
