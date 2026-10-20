package ca.erplibre.home.streamdeck;

/**
 * Whether restarting the session of one attached Stream Deck would help,
 * free of Android types so JUnit covers it. getSessionHealth reports the
 * verdict per deck; the app restarts only the decks found sick.
 *
 * The verdict reads only signals the plugin holds: permission, the
 * registry, the pending automatic reopen, whether the session's reader and
 * writer threads still run, the failed transfers in a row, and the time
 * since the last input report. A deck sends an input report only when a
 * key changes, so an idle deck and a deck whose interrupt-IN pipe went
 * quiet look the same: silence alone is no sickness. The caller that knows
 * the pipe may have gone quiet over a span, as the app back from a long
 * hide, passes that span as quietForMs, and a session that heard nothing
 * over it is QUIET: a restart is then the only way to tell the two apart.
 * A report within the span, as the press that woke the phone, proves the
 * pipe and spares the session.
 *
 * Sick, in this order:
 *   NO_SESSION      — permitted, nothing holds the device and no automatic
 *                     reopen is pending: given up, or closed by a path
 *                     that does not retry.
 *   READER_ENDED    — the session is open but its reader thread ended
 *                     without closing it (an uncaught exception).
 *   WRITER_ENDED    — same for the writer thread.
 *   WRITES_FAILING  — FAILURES_SICK bulk writes failed in a row.
 *   CONTROL_FAILING — FAILURES_SICK EP0 transfers failed in a row
 *                     (brightness, reset; a failed heartbeat is not
 *                     counted, see ControlPipe), on a session whose
 *                     control pipe is up (ControlPipe). One down since
 *                     open stays down across a restart, until a replug,
 *                     so its failures are no sickness until a request
 *                     goes through again.
 *   QUIET           — asked with quietForMs, no input report for at least
 *                     that long.
 * A deck without permission is never sick: a restart does not ask for
 * it. A device busy but not open — an attach holding the reservation, a
 * close in progress — is left to that path, as is a deck whose automatic
 * reopen is pending (ReattachPolicy).
 */
final class SessionHealth {

    /** Failed transfers in a row that make an open session sick. One is a
     *  stall the next transfer clears (see WriterStep); the writer closes
     *  the session itself at WriterStep.FAILURES_TO_CLOSE. */
    static final int FAILURES_SICK = 2;

    static final String NO_SESSION = "no_session";
    static final String READER_ENDED = "reader_ended";
    static final String WRITER_ENDED = "writer_ended";
    static final String WRITES_FAILING = "writes_failing";
    static final String CONTROL_FAILING = "control_failing";
    static final String QUIET = "quiet";

    private SessionHealth() {}

    /** What the plugin knows of one attached Stream Deck. */
    static final class Signals {
        final boolean permitted;
        /** A registered session or an attach in flight holds the device. */
        final boolean busy;
        /** A registered session is open (DeckSession.isOpen). */
        final boolean open;
        /** ReattachPolicy has a retry underway for the device. */
        final boolean reopening;
        final boolean readerAlive;
        final boolean writerAlive;
        final int writeFailuresInARow;
        final int controlFailuresInARow;
        /** The session's control pipe answered at open; true without one. */
        final boolean controlPipeOk;
        /** Since the session's last input report, or its open when none
         *  came; 0 without a session. */
        final long msSinceReport;

        /** A session whose control pipe answered at open. */
        Signals(boolean permitted, boolean busy, boolean open, boolean reopening,
                boolean readerAlive, boolean writerAlive,
                int writeFailuresInARow, int controlFailuresInARow) {
            this(permitted, busy, open, reopening, readerAlive, writerAlive,
                writeFailuresInARow, controlFailuresInARow, true);
        }

        Signals(boolean permitted, boolean busy, boolean open, boolean reopening,
                boolean readerAlive, boolean writerAlive,
                int writeFailuresInARow, int controlFailuresInARow,
                boolean controlPipeOk) {
            this(permitted, busy, open, reopening, readerAlive, writerAlive,
                writeFailuresInARow, controlFailuresInARow, controlPipeOk, 0);
        }

        private Signals(boolean permitted, boolean busy, boolean open, boolean reopening,
                        boolean readerAlive, boolean writerAlive,
                        int writeFailuresInARow, int controlFailuresInARow,
                        boolean controlPipeOk, long msSinceReport) {
            this.msSinceReport = msSinceReport;
            this.permitted = permitted;
            this.busy = busy;
            this.open = open;
            this.reopening = reopening;
            this.readerAlive = readerAlive;
            this.writerAlive = writerAlive;
            this.writeFailuresInARow = writeFailuresInARow;
            this.controlFailuresInARow = controlFailuresInARow;
            this.controlPipeOk = controlPipeOk;
        }

        /** These signals, the last input report {@code ms} ago. */
        Signals heardMsAgo(long ms) {
            return new Signals(permitted, busy, open, reopening, readerAlive, writerAlive,
                writeFailuresInARow, controlFailuresInARow, controlPipeOk, ms);
        }
    }

    /** "" when a restart would not help, else the reason it would;
     *  silence is never a reason. */
    static String sickness(Signals s) {
        return sickness(s, 0);
    }

    /** sickness(s), and QUIET for an open session that heard nothing for
     *  {@code quietForMs} or longer; 0 or less turns QUIET off. */
    static String sickness(Signals s, long quietForMs) {
        if (!s.permitted) return "";
        if (!s.busy) return s.reopening ? "" : NO_SESSION;
        if (!s.open) return "";
        if (!s.readerAlive) return READER_ENDED;
        if (!s.writerAlive) return WRITER_ENDED;
        if (s.writeFailuresInARow >= FAILURES_SICK) return WRITES_FAILING;
        if (s.controlPipeOk && s.controlFailuresInARow >= FAILURES_SICK) {
            return CONTROL_FAILING;
        }
        if (quietForMs > 0 && s.msSinceReport >= quietForMs) return QUIET;
        return "";
    }

    static boolean isSick(Signals s) { return !sickness(s).isEmpty(); }
}
