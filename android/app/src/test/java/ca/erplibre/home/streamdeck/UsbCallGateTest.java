package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public class UsbCallGateTest {

    /** Enters the gate, then stays inside for {@code ms}, deaf to interrupts. */
    static Thread callInside(UsbCallGate gate, long ms) throws InterruptedException {
        CountDownLatch entered = new CountDownLatch(1);
        Thread t = new Thread(() -> {
            assertTrue(gate.enter());
            entered.countDown();
            try {
                long end = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(ms);
                while (System.nanoTime() < end) Thread.onSpinWait();
            } finally {
                gate.leave();
            }
        });
        t.setDaemon(true);
        t.start();
        assertTrue(entered.await(1, TimeUnit.SECONDS));
        return t;
    }

    @Test
    public void an_open_gate_lets_calls_in() {
        UsbCallGate gate = new UsbCallGate();
        assertTrue(gate.enter());
        gate.leave();
        assertTrue(gate.awaitEmpty(0));
    }

    @Test
    public void a_shut_gate_refuses_new_calls() {
        UsbCallGate gate = new UsbCallGate();
        gate.shut();
        assertFalse(gate.enter());
        assertTrue(gate.awaitEmpty(0));
    }

    @Test
    public void await_empty_waits_for_the_call_inside() throws Exception {
        UsbCallGate gate = new UsbCallGate();
        Thread t = callInside(gate, 200);
        gate.shut();
        long start = System.nanoTime();
        assertTrue(gate.awaitEmpty(2000));
        long tookMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
        assertTrue("returned after " + tookMs + " ms", tookMs >= 100);
        t.join(1000);
        assertFalse(t.isAlive());
    }

    @Test
    public void await_empty_gives_up_at_the_bound() throws Exception {
        UsbCallGate gate = new UsbCallGate();
        callInside(gate, 1500);
        gate.shut();
        long start = System.nanoTime();
        assertFalse(gate.awaitEmpty(100));
        long tookMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
        assertTrue("returned after " + tookMs + " ms", tookMs < 1000);
    }

    @Test
    public void every_call_inside_is_waited_for() throws Exception {
        // Two heartbeat threads, one of them stopped by setHeartbeat, can
        // both be inside a transfer when the session closes.
        UsbCallGate gate = new UsbCallGate();
        Thread a = callInside(gate, 150);
        Thread b = callInside(gate, 300);
        gate.shut();
        assertTrue(gate.awaitEmpty(2000));
        b.join(1000);
        assertFalse(a.isAlive());
        assertFalse(b.isAlive());
    }

    @Test
    public void an_interrupted_caller_still_waits_and_keeps_its_interrupt() throws Exception {
        UsbCallGate gate = new UsbCallGate();
        callInside(gate, 150);
        gate.shut();
        Thread.currentThread().interrupt();
        assertTrue(gate.awaitEmpty(2000));
        assertTrue(Thread.interrupted());
    }
}
