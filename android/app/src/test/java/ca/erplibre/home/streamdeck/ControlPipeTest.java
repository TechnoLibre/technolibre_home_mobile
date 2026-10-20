package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

public class ControlPipeTest {

    @Test
    public void failed_requests_count_in_a_row_until_one_answers() {
        ControlPipe p = new ControlPipe();
        p.failed(true);
        p.failed(true);
        assertEquals(2, p.failuresInARow());
        p.answered();
        assertEquals(0, p.failuresInARow());
    }

    @Test
    public void a_failed_heartbeat_is_not_counted_and_an_answered_one_resets() {
        // A heartbeat stalls behind a busy bus and the next one answers:
        // its failures alone never make the session sick.
        ControlPipe p = new ControlPipe();
        for (int i = 0; i < 5; i++) p.failed(false);
        assertEquals(0, p.failuresInARow());
        p.failed(true);
        p.answered();
        assertEquals(0, p.failuresInARow());
    }

    @Test
    public void heartbeat_failures_do_not_reset_the_counted_ones() {
        ControlPipe p = new ControlPipe();
        p.failed(true);
        p.failed(false);
        p.failed(true);
        assertEquals(2, p.failuresInARow());
    }

    @Test
    public void a_pipe_up_at_open_gives_every_request_its_own_timeout() {
        ControlPipe p = new ControlPipe();
        p.opened(true, 0);
        assertTrue(p.up());
        assertEquals(1000, p.timeoutFor(1000, 0));
        assertEquals(1000, p.timeoutFor(1000, 1));
    }

    @Test
    public void a_pipe_down_at_open_refuses_until_the_retry_interval() {
        ControlPipe p = new ControlPipe();
        p.opened(false, 100);
        assertFalse(p.up());
        assertEquals(-1, p.timeoutFor(1000, 100));
        assertEquals(-1, p.timeoutFor(1000, 100 + ControlPipe.RETRY_MS - 1));
    }

    @Test
    public void a_pipe_down_is_retried_once_per_interval_with_the_short_timeout() {
        ControlPipe p = new ControlPipe();
        p.opened(false, 0);
        long t = ControlPipe.RETRY_MS;
        assertEquals(FeatureReads.PROBE_TIMEOUT_MS, p.timeoutFor(1000, t));
        p.failed(true);
        // The try just made starts the next interval.
        assertEquals(-1, p.timeoutFor(1000, t + 1));
        assertEquals(FeatureReads.PROBE_TIMEOUT_MS,
            p.timeoutFor(1000, t + ControlPipe.RETRY_MS));
    }

    @Test
    public void a_down_pipe_that_answers_is_up_again() {
        // A deck slow to answer right after open is not down for the
        // whole session: the first request that goes through restores it.
        ControlPipe p = new ControlPipe();
        p.opened(false, 0);
        assertTrue(p.answered());
        assertTrue(p.up());
        assertEquals(1000, p.timeoutFor(1000, 1));
        assertFalse(p.answered());
    }

    @Test
    public void the_retry_interval_bounds_a_down_pipe_cost_to_a_fraction() {
        // At most one short try per interval: a deck truly down costs a
        // caller under 10 % of its time in timeouts.
        assertTrue(FeatureReads.PROBE_TIMEOUT_MS * 10 <= ControlPipe.RETRY_MS);
    }
}
