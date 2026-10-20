package ca.erplibre.home.streamdeck;

/**
 * The feature reports DeckSession.open() reads on EP0, and whether the
 * deck's control pipe answers them at all; free of Android types so JUnit
 * covers it.
 *
 * The firmware report goes first, as a probe: PROBE_TIMEOUT_MS, then one
 * retry after RETRY_PAUSE_MS. A deck whose control pipe fails every
 * class request keeps failing them across reopens, until a USB reset (a
 * replug); a deck that answers neither probe is reported down, and open()
 * skips the serial read rather than spend READ_TIMEOUT_MS on it.
 * ControlPipe then tries the pipe again now and then, so a deck merely
 * slow to answer at open is not down for the whole session. A deck
 * that answers the probe gets its serial read with READ_TIMEOUT_MS; a
 * failed serial no longer costs the firmware, nor the reverse.
 *
 * On a down pipe, one standard GET_DESCRIPTOR(device) tells a dead default
 * pipe (no answer either) from a deck whose HID request handler alone
 * fails (the descriptor answers). It is reported for the log only.
 *
 * Report IDs and header lengths are python-elgato-streamdeck's:
 * firmware 0x05 after 6 bytes and serial 0x06 after 2 for gen 2, firmware
 * 0x04 and serial 0x03, both after 5, for gen 1.
 */
final class FeatureReads {

    /** EP0 transfers on the open connection. */
    interface Ep0 {
        /** HID GET_REPORT of a feature report into buf: bytes read, or
         *  negative on failure. */
        int getFeature(int reportId, byte[] buf, int timeoutMs);
        /** Standard GET_DESCRIPTOR(device) into buf: bytes read, or
         *  negative on failure. */
        int getDeviceDescriptor(byte[] buf, int timeoutMs);
    }

    /** Thread.sleep in the app; recorded in tests. */
    interface Pause {
        void sleep(long ms) throws InterruptedException;
    }

    /** A healthy deck answers a GET_REPORT within a few milliseconds. */
    static final int PROBE_TIMEOUT_MS = 250;
    static final long RETRY_PAUSE_MS = 100;
    static final int READ_TIMEOUT_MS = 1000;
    static final int DESCRIPTOR_TIMEOUT_MS = 300;

    private static final int REPORT_LEN = 32;
    private static final int DEVICE_DESCRIPTOR_LEN = 18;

    static final class Result {
        /** False when neither firmware probe went through. */
        final boolean controlPipeOk;
        /** Null when unread. */
        final String firmware;
        /** Null when unread or empty. */
        final String serial;
        /** Meaningful only when !controlPipeOk: GET_DESCRIPTOR answered. */
        final boolean standardRequestsAnswer;

        Result(boolean controlPipeOk, String firmware, String serial,
               boolean standardRequestsAnswer) {
            this.controlPipeOk = controlPipeOk;
            this.firmware = firmware;
            this.serial = serial;
            this.standardRequestsAnswer = standardRequestsAnswer;
        }
    }

    private FeatureReads() {}

    /** Reads firmware then serial; v2 picks the generation's reports.
     *  An interrupt during the pause ends the reads, the pipe reported
     *  down, with the thread's interrupt status kept. */
    static Result read(boolean v2, Ep0 ep0, Pause pause) {
        int firmwareId = v2 ? 0x05 : 0x04;
        int firmwareHeader = v2 ? 6 : 5;
        int serialId = v2 ? 0x06 : 0x03;
        int serialHeader = v2 ? 2 : 5;

        byte[] buf = new byte[REPORT_LEN];
        int got = feature(ep0, firmwareId, buf, PROBE_TIMEOUT_MS);
        if (got < 0) {
            try {
                pause.sleep(RETRY_PAUSE_MS);
                got = feature(ep0, firmwareId, buf, PROBE_TIMEOUT_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        if (got < 0) {
            byte[] desc = new byte[DEVICE_DESCRIPTOR_LEN];
            int d;
            try {
                d = ep0.getDeviceDescriptor(desc, DESCRIPTOR_TIMEOUT_MS);
            } catch (RuntimeException e) {
                d = -1;
            }
            return new Result(false, null, null, d >= 0);
        }
        String firmware = ascii(buf, firmwareHeader, got);

        byte[] sbuf = new byte[REPORT_LEN];
        int sgot = feature(ep0, serialId, sbuf, READ_TIMEOUT_MS);
        String serial = sgot < 0 ? null : ascii(sbuf, serialHeader, sgot);
        if (serial != null && serial.isEmpty()) serial = null;
        return new Result(true, firmware, serial, true);
    }

    private static int feature(Ep0 ep0, int reportId, byte[] buf, int timeoutMs) {
        try {
            return ep0.getFeature(reportId, buf, timeoutMs);
        } catch (RuntimeException e) {
            return -1;
        }
    }

    /** Printable ASCII of buf from headerLen up to len or the first NUL. */
    static String ascii(byte[] buf, int headerLen, int len) {
        StringBuilder sb = new StringBuilder();
        for (int i = headerLen; i < Math.min(len, buf.length); i++) {
            byte b = buf[i];
            if (b == 0) break;
            if (b >= 0x20 && b < 0x7f) sb.append((char) b);
        }
        return sb.toString();
    }
}
