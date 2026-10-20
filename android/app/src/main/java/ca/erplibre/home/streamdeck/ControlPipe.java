package ca.erplibre.home.streamdeck;

/**
 * The failed class requests in a row on one session's EP0, free of
 * Android types so JUnit covers it. SessionHealth reads the count.
 *
 * Brightness and reset count their failures. The heartbeat does not: it
 * runs every HEARTBEAT_MS whether or not anything needs the pipe, a stall
 * behind a busy bus fails a few of them in a row, and the next one
 * answers. Its answers still count, as proof the pipe works. Every method
 * holds the instance monitor: the heartbeat and the plugin calls run on
 * different threads.
 */
final class ControlPipe {

    private int failuresInARow = 0;

    /** A class request went through. */
    synchronized void answered() {
        failuresInARow = 0;
    }

    /** A class request failed; {@code counted} is false for a heartbeat. */
    synchronized void failed(boolean counted) {
        if (counted) failuresInARow++;
    }

    /** Counted failures since the last request that went through. */
    synchronized int failuresInARow() {
        return failuresInARow;
    }
}
