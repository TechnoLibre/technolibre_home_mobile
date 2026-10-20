package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public class KeyEventGateTest {

    private final List<String> delivered = Collections.synchronizedList(new ArrayList<>());
    private final KeyEventGate<String> gate =
        new KeyEventGate<>(delivered::add, 4, 10_000L);

    @Test
    public void a_closed_gate_holds_events() {
        gate.submit("p0", 0L);
        gate.submit("r0", 10L);
        assertFalse(gate.isOpen());
        assertTrue(delivered.isEmpty());
    }

    @Test
    public void open_delivers_the_held_events_in_order_then_lets_events_through() {
        gate.submit("p0", 0L);
        gate.submit("r0", 10L);
        KeyEventGate.Release r = gate.open(20L);
        assertEquals(2, r.delivered);
        assertEquals(0, r.dropped);
        assertTrue(gate.isOpen());
        gate.submit("p1", 30L);
        assertEquals(Arrays.asList("p0", "r0", "p1"), delivered);
    }

    @Test
    public void the_oldest_events_go_past_the_bound() {
        for (int i = 0; i < 6; i++) gate.submit("e" + i, i);
        KeyEventGate.Release r = gate.open(10L);
        assertEquals(Arrays.asList("e2", "e3", "e4", "e5"), delivered);
        assertEquals(4, r.delivered);
        assertEquals(2, r.dropped);
    }

    @Test
    public void events_older_than_the_age_limit_are_dropped_at_open() {
        gate.submit("p0", 0L);
        gate.submit("r0", 1_000L);
        gate.submit("p1", 5_000L);
        KeyEventGate.Release r = gate.open(11_000L);
        assertEquals(Arrays.asList("r0", "p1"), delivered);
        assertEquals(1, r.dropped);
    }

    @Test
    public void an_event_exactly_at_the_age_limit_is_kept() {
        gate.submit("p0", 0L);
        gate.open(10_000L);
        assertEquals(Collections.singletonList("p0"), delivered);
    }

    @Test
    public void a_kept_press_keeps_its_release_after_it() {
        // Trimming takes from the front only, so a release is never lost
        // while its press is delivered.
        String[] seq = {"p0", "r0", "p1", "r1", "p2", "r2"};
        for (int i = 0; i < seq.length; i++) gate.submit(seq[i], i);
        gate.open(10L);
        assertEquals(Arrays.asList("p1", "r1", "p2", "r2"), delivered);
    }

    @Test
    public void close_holds_again_until_the_next_open() {
        gate.open(0L);
        gate.close();
        assertFalse(gate.isOpen());
        gate.submit("p0", 100L);
        assertTrue(delivered.isEmpty());
        KeyEventGate.Release r = gate.open(200L);
        assertEquals(1, r.delivered);
        assertEquals(Collections.singletonList("p0"), delivered);
    }

    @Test
    public void a_second_open_delivers_nothing_more() {
        gate.submit("p0", 0L);
        gate.open(1L);
        KeyEventGate.Release r = gate.open(2L);
        assertEquals(0, r.delivered);
        assertEquals(0, r.dropped);
        assertEquals(Collections.singletonList("p0"), delivered);
    }

    @Test
    public void the_drop_count_restarts_at_each_open() {
        for (int i = 0; i < 6; i++) gate.submit("e" + i, i);
        gate.open(10L);
        gate.close();
        gate.submit("f0", 20L);
        KeyEventGate.Release r = gate.open(30L);
        assertEquals(0, r.dropped);
    }

    @Test
    public void an_open_racing_a_reader_keeps_every_event_in_order() throws Exception {
        List<Integer> out = Collections.synchronizedList(new ArrayList<>());
        KeyEventGate<Integer> g = new KeyEventGate<>(out::add, 100_000, 10_000L);
        final int n = 20_000;
        Thread reader = new Thread(() -> {
            for (int i = 0; i < n; i++) g.submit(i, 0L);
        });
        reader.start();
        while (out.isEmpty() && reader.isAlive()) g.open(0L);
        g.open(0L);
        reader.join();
        assertEquals(n, out.size());
        for (int i = 0; i < n; i++) assertEquals(Integer.valueOf(i), out.get(i));
    }
}
