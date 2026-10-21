package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

public class CloseOnceTest {

    /** Calls finish() after {@code ms}, as a first close() ends. */
    static void finishLater(CloseOnce once, long ms) {
        Thread t = new Thread(() -> {
            try { Thread.sleep(ms); } catch (InterruptedException ignored) { }
            once.finish();
        });
        t.setDaemon(true);
        t.start();
    }

    @Test
    public void only_the_first_caller_claims_the_close() {
        CloseOnce once = new CloseOnce();
        assertFalse(once.started());
        assertTrue(once.claim());
        assertTrue(once.started());
        assertFalse(once.claim());
    }

    @Test
    public void a_later_caller_waits_until_the_close_finished() {
        // restartSessions closes a session the reader is closing: it must
        // find the session unregistered once its own close() returns.
        CloseOnce once = new CloseOnce();
        once.claim();
        finishLater(once, 200);
        long start = System.nanoTime();
        assertTrue(once.awaitFinished(Collections.emptyList(), 2000));
        long tookMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
        assertTrue("returned after " + tookMs + " ms", tookMs >= 150);
    }

    @Test
    public void nothing_to_wait_for_before_a_close_started() {
        assertTrue(new CloseOnce().awaitFinished(Collections.emptyList(), 2000));
    }

    @Test
    public void the_wait_gives_up_at_the_bound() {
        CloseOnce once = new CloseOnce();
        once.claim();
        long start = System.nanoTime();
        assertFalse(once.awaitFinished(Collections.emptyList(), 100));
        long tookMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
        assertTrue("returned after " + tookMs + " ms", tookMs < 1000);
    }

    @Test
    public void a_worker_of_the_session_does_not_wait() throws Exception {
        // The first close() waits for the reader: a reader that waited for
        // that close() in turn would hold both until the bound.
        CloseOnce once = new CloseOnce();
        once.claim();
        AtomicBoolean answered = new AtomicBoolean(false);
        AtomicLong tookMs = new AtomicLong();
        CountDownLatch done = new CountDownLatch(1);
        Thread[] self = new Thread[1];
        self[0] = new Thread(() -> {
            long start = System.nanoTime();
            answered.set(once.awaitFinished(Arrays.asList(null, self[0]), 2000));
            tookMs.set(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start));
            done.countDown();
        });
        self[0].start();
        assertTrue(done.await(1, TimeUnit.SECONDS));
        assertTrue(answered.get());
        assertTrue("returned after " + tookMs.get() + " ms", tookMs.get() < 500);
    }

    @Test
    public void an_interrupted_caller_still_waits_and_keeps_its_interrupt() {
        CloseOnce once = new CloseOnce();
        once.claim();
        finishLater(once, 150);
        Thread.currentThread().interrupt();
        assertTrue(once.awaitFinished(Collections.emptyList(), 2000));
        assertTrue(Thread.interrupted());
    }
}
