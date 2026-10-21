package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public class ParallelCloseTest {

    /** A close that takes {@code ms}, deaf to interrupts, then counts down. */
    static Runnable slowClose(long ms, CountDownLatch done) {
        return () -> {
            long end = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(ms);
            while (System.nanoTime() < end) Thread.onSpinWait();
            done.countDown();
        };
    }

    static long msSince(long start) {
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
    }

    @Test
    public void closes_run_side_by_side_within_one_bound() {
        // Three decks closing at app destroy: the main thread waits for the
        // slowest close, not for the sum of them.
        CountDownLatch done = new CountDownLatch(3);
        List<Runnable> closes = new ArrayList<>();
        for (int i = 0; i < 3; i++) closes.add(slowClose(300, done));
        long start = System.nanoTime();
        assertEquals(0, ParallelClose.run(closes, "t", 2000));
        long tookMs = msSince(start);
        assertEquals(0, done.getCount());
        assertTrue("returned after " + tookMs + " ms", tookMs < 800);
    }

    @Test
    public void a_close_past_the_bound_is_counted() {
        CountDownLatch done = new CountDownLatch(2);
        List<Runnable> closes = List.of(slowClose(50, done), slowClose(1500, done));
        long start = System.nanoTime();
        assertEquals(1, ParallelClose.run(closes, "t", 200));
        long tookMs = msSince(start);
        assertTrue("returned after " + tookMs + " ms", tookMs < 1000);
    }

    @Test
    public void a_zero_bound_returns_at_once_and_the_close_still_runs() throws Exception {
        // A detach seen on the main thread hands its close over and goes on.
        CountDownLatch done = new CountDownLatch(1);
        long start = System.nanoTime();
        assertEquals(1, ParallelClose.run(List.of(slowClose(300, done)), "t", 0));
        assertTrue(msSince(start) < 200);
        assertTrue(done.await(2, TimeUnit.SECONDS));
    }

    @Test
    public void the_closes_run_off_the_calling_thread() throws Exception {
        Thread caller = Thread.currentThread();
        List<Thread> ranOn = Collections.synchronizedList(new ArrayList<>());
        ParallelClose.run(List.of(() -> ranOn.add(Thread.currentThread())), "deck-close", 2000);
        assertEquals(1, ranOn.size());
        assertNotSame(caller, ranOn.get(0));
        assertEquals("deck-close", ranOn.get(0).getName());
    }

    @Test
    public void no_close_returns_at_once() {
        assertEquals(0, ParallelClose.run(Collections.emptyList(), "t", 2000));
    }

    @Test
    public void an_interrupted_caller_still_waits_and_keeps_its_interrupt() {
        CountDownLatch done = new CountDownLatch(1);
        Thread.currentThread().interrupt();
        assertEquals(0, ParallelClose.run(List.of(slowClose(150, done)), "t", 2000));
        assertTrue(Thread.interrupted());
        assertEquals(0, done.getCount());
    }
}
