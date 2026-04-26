package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;
import java.util.concurrent.atomic.AtomicInteger;

public class WriterQueueTest {

    /** Minimal WriteJob impl for tests — just records "dropped" / "executed". */
    static class FakeJob extends WriteJob {
        final String slot;
        boolean droppedFlag = false;
        FakeJob(String slot) { this.slot = slot; }
        @Override public String slotKey() { return slot; }
        @Override public void resolveDropped() { droppedFlag = true; }
        @Override public void runTransport() { /* no-op for these tests */ }
    }

    @Test
    public void single_offer_then_take_returns_same_job() throws InterruptedException {
        WriterQueue q = new WriterQueue();
        FakeJob j = new FakeJob("key:0");
        q.offerCoalesce(j);
        assertSame(j, q.take());
        assertFalse(j.droppedFlag);
    }

    @Test
    public void second_offer_same_slot_drops_first() throws InterruptedException {
        WriterQueue q = new WriterQueue();
        FakeJob j1 = new FakeJob("key:5");
        FakeJob j2 = new FakeJob("key:5");
        q.offerCoalesce(j1);
        q.offerCoalesce(j2);
        assertTrue(j1.droppedFlag);
        assertFalse(j2.droppedFlag);
        assertSame(j2, q.take());
    }

    @Test
    public void different_slots_do_not_coalesce() throws InterruptedException {
        WriterQueue q = new WriterQueue();
        FakeJob a = new FakeJob("key:0");
        FakeJob b = new FakeJob("key:1");
        q.offerCoalesce(a);
        q.offerCoalesce(b);
        assertFalse(a.droppedFlag);
        assertFalse(b.droppedFlag);
        assertSame(a, q.take());
        assertSame(b, q.take());
    }

    @Test
    public void take_blocks_until_offer() throws Exception {
        WriterQueue q = new WriterQueue();
        AtomicInteger taken = new AtomicInteger(0);
        Thread t = new Thread(() -> {
            try { q.take(); taken.incrementAndGet(); } catch (InterruptedException ignored) {}
        });
        t.start();
        Thread.sleep(50);
        assertEquals(0, taken.get());
        q.offerCoalesce(new FakeJob("x"));
        t.join(500);
        assertEquals(1, taken.get());
    }

    @Test
    public void close_drains_remaining_with_dropped() {
        WriterQueue q = new WriterQueue();
        FakeJob a = new FakeJob("key:0");
        FakeJob b = new FakeJob("key:1");
        q.offerCoalesce(a);
        q.offerCoalesce(b);
        q.closeAndDrainAsDropped();
        assertTrue(a.droppedFlag);
        assertTrue(b.droppedFlag);
    }
}
