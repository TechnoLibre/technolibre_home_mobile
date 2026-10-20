package ca.erplibre.home.streamdeck;

/**
 * What the writer thread does with one job, free of Android types so JUnit
 * covers it. One instance per writer thread: it counts the failed transfers
 * in a row.
 *
 * A job settles its own Promise in every case. A rejected input — bad
 * format, undecodable image — leaves the session as it is. A failed USB
 * transfer surfaces as DeckIoException. bulkTransfer answers -1 to a
 * timeout as to a gone pipe, so one failure cannot tell a firmware stall
 * from a dead OUT pipe: a stall fails one transfer and the next goes
 * through, a dead pipe fails every one. The session is closed after
 * FAILURES_TO_CLOSE failures in a row; any job that ends without a
 * failed transfer resets the count. Closing goes through
 * DeckSession.close(), which unregisters the session and sends
 * deckDisconnected exactly as a reader failure does.
 */
final class WriterStep {

    /** Reason prefix of a close caused by a write; the transfer detail follows. */
    static final String CLOSE_REASON = "usb_lost";

    /** Failed transfers in a row that close the session. */
    static final int FAILURES_TO_CLOSE = 3;

    /** The session the writer serves, as far as a failed write concerns it. */
    interface Owner {
        void closeAfterWriteFailure(String reason);
    }

    private final Owner owner;
    private int failuresInARow = 0;

    WriterStep(Owner owner) { this.owner = owner; }

    /** Runs {@code job}; false when its transfer failed and the session was closed. */
    boolean run(WriteJob job) {
        try {
            job.runTransport();
            failuresInARow = 0;
            return true;
        } catch (DeckSession.DeckIoException e) {
            if (++failuresInARow < FAILURES_TO_CLOSE) return true;
            owner.closeAfterWriteFailure(CLOSE_REASON + ":" + e.getMessage());
            return false;
        }
    }
}
