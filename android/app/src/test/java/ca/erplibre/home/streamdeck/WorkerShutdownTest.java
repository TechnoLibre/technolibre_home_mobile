package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

public class WorkerShutdownTest {

    /** Blocks in sleep, which an interrupt ends at once (the writer's take). */
    static Thread sleeper() {
        Thread t = new Thread(() -> {
            try { Thread.sleep(60_000); } catch (InterruptedException ignored) { }
        });
        t.setDaemon(true);
        t.start();
        return t;
    }

    /** Ignores interrupts until {@code ms} passed, as a native USB call does. */
    static Thread nativeCall(long ms) {
        Thread t = new Thread(() -> {
            long end = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(ms);
            while (System.nanoTime() < end) Thread.onSpinWait();
        });
        t.setDaemon(true);
        t.start();
        return t;
    }

    @Test
    public void stop_returns_once_interrupted_workers_ended() {
        Thread a = sleeper();
        Thread b = sleeper();
        List<Thread> alive = WorkerShutdown.stop(Arrays.asList(a, b), 2000);
        assertTrue(alive.isEmpty());
        assertFalse(a.isAlive());
        assertFalse(b.isAlive());
    }

    @Test
    public void stop_waits_for_a_worker_deaf_to_interrupts() {
        Thread t = nativeCall(200);
        long start = System.nanoTime();
        List<Thread> alive = WorkerShutdown.stop(Arrays.asList(t), 2000);
        long tookMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
        assertTrue(alive.isEmpty());
        assertFalse(t.isAlive());
        assertTrue("returned after " + tookMs + " ms", tookMs >= 150);
    }

    @Test
    public void a_worker_past_the_bound_is_returned_alive() {
        Thread t = nativeCall(1500);
        long start = System.nanoTime();
        List<Thread> alive = WorkerShutdown.stop(Arrays.asList(t), 100);
        long tookMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
        assertEquals(Arrays.asList(t), alive);
        assertTrue("returned after " + tookMs + " ms", tookMs < 1000);
    }

    @Test
    public void the_bound_covers_all_workers_together() {
        Thread a = nativeCall(1500);
        Thread b = nativeCall(1500);
        long start = System.nanoTime();
        List<Thread> alive = WorkerShutdown.stop(Arrays.asList(a, b), 200);
        long tookMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
        assertEquals(2, alive.size());
        assertTrue("returned after " + tookMs + " ms", tookMs < 1000);
    }

    @Test
    public void a_worker_stopping_its_session_skips_itself() throws Exception {
        // close() runs on the reader or the writer when the USB pipe fails:
        // that thread cannot wait for its own end.
        Thread other = sleeper();
        AtomicReference<List<Thread>> alive = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        Thread[] self = new Thread[1];
        self[0] = new Thread(() -> {
            alive.set(WorkerShutdown.stop(Arrays.asList(self[0], other), 2000));
            assertFalse(Thread.currentThread().isInterrupted());
            done.countDown();
        });
        self[0].start();
        assertTrue(done.await(1, TimeUnit.SECONDS));
        assertTrue(alive.get().isEmpty());
        assertFalse(other.isAlive());
    }

    @Test
    public void absent_workers_are_skipped() {
        assertTrue(WorkerShutdown.stop(Arrays.asList(null, sleeper(), null), 2000).isEmpty());
    }

    @Test
    public void an_interrupted_caller_still_waits_and_keeps_its_interrupt() {
        Thread t = nativeCall(150);
        Thread.currentThread().interrupt();
        List<Thread> alive = WorkerShutdown.stop(Arrays.asList(t), 2000);
        assertTrue(Thread.interrupted());
        assertTrue(alive.isEmpty());
        assertFalse(t.isAlive());
    }
}
