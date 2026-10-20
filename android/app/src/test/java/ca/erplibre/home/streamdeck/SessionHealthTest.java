package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

public class SessionHealthTest {

    /** An open session whose reader and writer run and whose last
     *  transfers went through. */
    private static SessionHealth.Signals healthy() {
        return new SessionHealth.Signals(true, true, true, false, true, true, 0, 0);
    }

    private static SessionHealth.Signals noSession(boolean permitted, boolean reopening) {
        return new SessionHealth.Signals(permitted, false, false, reopening, false, false, 0, 0);
    }

    @Test
    public void open_session_with_both_workers_and_no_failure_is_healthy() {
        assertEquals("", SessionHealth.sickness(healthy()));
    }

    @Test
    public void idle_deck_is_not_sick() {
        // An idle deck sends no input report: without a quiet bound,
        // however long the silence, it is no sickness.
        SessionHealth.Signals idle = healthy().heardMsAgo(3_600_000L);
        assertFalse(SessionHealth.isSick(idle));
        assertEquals("", SessionHealth.sickness(idle, 0));
    }

    @Test
    public void deck_that_heard_nothing_within_the_quiet_bound_is_quiet() {
        // Asked after a long hide with the hide's length: an interrupt-IN
        // pipe gone quiet over the hide looks like an idle deck, and a
        // restart is the only thing that tells them apart.
        assertEquals(SessionHealth.QUIET, SessionHealth.sickness(
            healthy().heardMsAgo(60_000L), 60_000L));
        assertEquals(SessionHealth.QUIET, SessionHealth.sickness(
            healthy().heardMsAgo(90_000L), 60_000L));
    }

    @Test
    public void deck_that_sent_a_report_within_the_quiet_bound_is_not_quiet() {
        // The press that woke the phone proves the pipe works.
        assertEquals("", SessionHealth.sickness(healthy().heardMsAgo(800L), 60_000L));
        assertEquals("", SessionHealth.sickness(healthy(), 60_000L));
    }

    @Test
    public void quiet_comes_after_every_other_sickness_and_only_for_an_open_session() {
        SessionHealth.Signals readerEnded =
            new SessionHealth.Signals(true, true, true, false, false, true, 0, 0)
                .heardMsAgo(90_000L);
        assertEquals(SessionHealth.READER_ENDED, SessionHealth.sickness(readerEnded, 60_000L));
        assertEquals("", SessionHealth.sickness(
            new SessionHealth.Signals(true, true, false, false, false, false, 0, 0)
                .heardMsAgo(90_000L), 60_000L));
        assertEquals("", SessionHealth.sickness(
            new SessionHealth.Signals(false, true, true, false, true, true, 0, 0)
                .heardMsAgo(90_000L), 60_000L));
    }

    @Test
    public void attached_permitted_deck_with_no_session_and_no_retry_is_sick() {
        // Session closed and the automatic reopen gave up, or never
        // applied (an owner close): nothing will reopen it.
        assertEquals(SessionHealth.NO_SESSION, SessionHealth.sickness(noSession(true, false)));
    }

    @Test
    public void deck_waiting_for_its_automatic_reopen_is_left_to_it() {
        assertEquals("", SessionHealth.sickness(noSession(true, true)));
    }

    @Test
    public void deck_without_permission_is_never_sick() {
        // A restart opens nothing without permission: it never asks.
        assertEquals("", SessionHealth.sickness(noSession(false, false)));
        assertEquals("", SessionHealth.sickness(
            new SessionHealth.Signals(false, true, true, false, false, false, 9, 9)));
    }

    @Test
    public void attach_in_flight_or_close_in_progress_is_not_sick() {
        // busy but not open: an attach holds the reservation, or a close
        // is running whose CloseListener decides what follows.
        assertEquals("", SessionHealth.sickness(
            new SessionHealth.Signals(true, true, false, false, false, false, 0, 0)));
    }

    @Test
    public void open_session_whose_reader_ended_is_sick() {
        assertEquals(SessionHealth.READER_ENDED, SessionHealth.sickness(
            new SessionHealth.Signals(true, true, true, false, false, true, 0, 0)));
    }

    @Test
    public void open_session_whose_writer_ended_is_sick() {
        assertEquals(SessionHealth.WRITER_ENDED, SessionHealth.sickness(
            new SessionHealth.Signals(true, true, true, false, true, false, 0, 0)));
    }

    @Test
    public void one_failed_write_is_a_stall_not_a_sickness() {
        assertEquals("", SessionHealth.sickness(
            new SessionHealth.Signals(true, true, true, false, true, true, 1, 1)));
    }

    @Test
    public void writes_failing_in_a_row_make_the_session_sick() {
        assertEquals(SessionHealth.WRITES_FAILING, SessionHealth.sickness(
            new SessionHealth.Signals(true, true, true, false, true, true,
                SessionHealth.FAILURES_SICK, 0)));
    }

    @Test
    public void control_transfers_failing_in_a_row_make_the_session_sick() {
        assertEquals(SessionHealth.CONTROL_FAILING, SessionHealth.sickness(
            new SessionHealth.Signals(true, true, true, false, true, true,
                0, SessionHealth.FAILURES_SICK)));
    }

    @Test
    public void control_failures_on_a_pipe_down_since_open_are_no_sickness() {
        // A restart reopens the deck with the same dead control pipe:
        // only a replug clears it, so the restart would cost the keys'
        // images for nothing.
        assertEquals("", SessionHealth.sickness(
            new SessionHealth.Signals(true, true, true, false, true, true,
                0, SessionHealth.FAILURES_SICK, false)));
        // Write failures on such a session still count.
        assertEquals(SessionHealth.WRITES_FAILING, SessionHealth.sickness(
            new SessionHealth.Signals(true, true, true, false, true, true,
                SessionHealth.FAILURES_SICK, SessionHealth.FAILURES_SICK, false)));
    }

    @Test
    public void sick_threshold_stays_below_the_writer_close() {
        // The writer closes the session at FAILURES_TO_CLOSE: a session
        // still open with failures in a row is caught before that.
        assertTrue(SessionHealth.FAILURES_SICK < WriterStep.FAILURES_TO_CLOSE);
        assertTrue(SessionHealth.FAILURES_SICK > 1);
    }

    @Test
    public void reader_end_is_reported_before_write_failures() {
        assertEquals(SessionHealth.READER_ENDED, SessionHealth.sickness(
            new SessionHealth.Signals(true, true, true, false, false, false, 5, 5)));
    }
}
