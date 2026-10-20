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
}
