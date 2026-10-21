package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

public class FocusSpanTest {

    private static final long SETTLE = FocusSpan.SETTLE_MS;

    private final FocusSpan span = new FocusSpan();

    @Test
    public void a_span_starts_once_resumed_and_focused() {
        assertFalse(span.resumed(true, 100));
        assertTrue(span.focused(true, 120));
        assertEquals(120, span.settledSince(120 + SETTLE));
    }

    @Test
    public void the_order_of_resume_and_focus_does_not_matter() {
        assertFalse(span.focused(true, 100));
        assertTrue(span.resumed(true, 130));
        assertEquals(130, span.settledSince(130 + SETTLE));
    }

    @Test
    public void a_span_younger_than_the_settle_delay_is_not_settled() {
        span.resumed(true, 100);
        span.focused(true, 100);
        assertEquals(-1, span.settledSince(100 + SETTLE - 1));
    }

    @Test
    public void losing_focus_ends_the_span() {
        // The system's confirmation coming up over the app takes its focus.
        span.resumed(true, 100);
        span.focused(true, 100);
        span.focused(false, 150);
        assertEquals(-1, span.settledSince(100 + SETTLE));
    }

    @Test
    public void a_pause_ends_the_span() {
        span.resumed(true, 100);
        span.focused(true, 100);
        span.resumed(false, 150);
        assertEquals(-1, span.settledSince(100 + SETTLE));
    }

    @Test
    public void focus_back_starts_a_new_span_from_its_own_instant() {
        span.resumed(true, 100);
        span.focused(true, 100);
        span.focused(false, 150);
        assertTrue(span.focused(true, 5_000));
        assertEquals(-1, span.settledSince(100 + SETTLE));
        assertEquals(5_000, span.settledSince(5_000 + SETTLE));
    }

    @Test
    public void a_repeated_event_does_not_restart_the_span() {
        span.resumed(true, 100);
        span.focused(true, 100);
        assertFalse(span.focused(true, 600));
        assertFalse(span.resumed(true, 700));
        assertEquals(100, span.settledSince(100 + SETTLE));
    }

    @Test
    public void focus_while_paused_starts_nothing() {
        // A window can report focus around a pause; only both together
        // mean the app holds the screen.
        assertFalse(span.focused(true, 100));
        assertEquals(-1, span.settledSince(100 + SETTLE));
    }

    @Test
    public void a_shared_screen_starts_no_span() {
        // In multi-window mode the confirmation can sit in another window,
        // answerable, while the app is resumed and focused.
        assertFalse(span.shared(true, 90));
        assertFalse(span.resumed(true, 100));
        assertFalse(span.focused(true, 100));
        assertEquals(-1, span.settledSince(100 + SETTLE));
    }

    @Test
    public void sharing_the_screen_ends_the_span() {
        span.resumed(true, 100);
        span.focused(true, 100);
        assertFalse(span.shared(true, 150));
        assertEquals(-1, span.settledSince(100 + SETTLE));
    }

    @Test
    public void the_full_screen_back_starts_a_span_from_its_own_instant() {
        span.shared(true, 50);
        span.resumed(true, 100);
        span.focused(true, 100);
        assertTrue(span.shared(false, 3_000));
        assertEquals(-1, span.settledSince(100 + SETTLE));
        assertEquals(3_000, span.settledSince(3_000 + SETTLE));
    }
}
