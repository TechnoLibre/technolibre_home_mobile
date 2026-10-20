package ca.erplibre.home.streamdeck;

/**
 * What the writer thread does with one job, free of Android types so JUnit
 * covers it.
 *
 * A job settles its own Promise in every case. A rejected input — bad
 * format, undecodable image — leaves the session as it is. A failed USB
 * transfer surfaces as DeckIoException: the OUT pipe is gone or wedged, so
 * every later write would fail the same way, and the session is closed at
 * once. Closing goes through DeckSession.close(), which unregisters the
 * session and sends deckDisconnected exactly as a reader failure does.
 */
final class WriterStep {

    /** Reason prefix of a close caused by a write; the transfer detail follows. */
    static final String CLOSE_REASON = "usb_lost";

    /** The session the writer serves, as far as a failed write concerns it. */
    interface Owner {
        void closeAfterWriteFailure(String reason);
    }

    private WriterStep() {}

    /** Runs {@code job}; false when its transfer failed and the session was closed. */
    static boolean run(WriteJob job, Owner owner) {
        try {
            job.runTransport();
            return true;
        } catch (DeckSession.DeckIoException e) {
            owner.closeAfterWriteFailure(CLOSE_REASON + ":" + e.getMessage());
            return false;
        }
    }
}
