package ca.erplibre.home.streamdeck;

import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.hardware.usb.UsbRequest;
import android.util.Log;

import java.nio.ByteBuffer;

import com.getcapacitor.JSObject;

import java.util.List;

import ca.erplibre.home.streamdeck.encoder.BmpEncoder;
import ca.erplibre.home.streamdeck.encoder.ImageEncoder;
import ca.erplibre.home.streamdeck.encoder.JpegEncoder;
import ca.erplibre.home.streamdeck.events.EventEmitter;
import ca.erplibre.home.streamdeck.transport.DeckTransport;
import ca.erplibre.home.streamdeck.transport.TransportV1;
import ca.erplibre.home.streamdeck.transport.TransportV2;

/**
 * One open Stream Deck. Owns all per-device threads and resources.
 *
 * Lifecycle:
 *   constructor (no I/O)
 *   open(usbConnection, iface) — claim, read serial, start threads
 *   close() — kill threads, drain queue with rejected promises, release iface
 */
public final class DeckSession {

    private static final String TAG = "StreamDeckSession";
    private static final int    BULK_WRITE_TIMEOUT_MS = 500;
    private static final int    BULK_READ_TIMEOUT_MS  = 1000;

    private final DeckSpec spec;
    private final UsbDevice device;
    private final EventEmitter emitter;
    private final WriterQueue queue = new WriterQueue();
    private final DeckTransport transport;
    private final ImageEncoder encoder;

    private UsbDeviceConnection connection;
    private UsbInterface iface;
    private UsbEndpoint epIn;
    private UsbEndpoint epOut;
    private String serial = "";
    private String firmware = "";

    private Thread readerThread;
    private Thread writerThread;
    /** Heartbeat sends a benign GET_REPORT on EP0 every HEARTBEAT_MS
     *  while the session is open. Without it, the USB bus enters
     *  selective suspend within ~1 s after the phone screen turns off
     *  (PARTIAL_WAKE_LOCK keeps the CPU awake but doesn't drive bus
     *  traffic), and the deck firmware reacts to the SOF starvation
     *  by pulsing LCD brightness at ~1 Hz — visible as fast dim
     *  flicker on Plus + XL during sleep. A control transfer is the
     *  cheapest activity we can produce; reader interrupt-IN tokens
     *  alone aren't enough on at least Pixel 6 / ThinkPhone kernels. */
    private Thread heartbeatThread;
    private static final long HEARTBEAT_MS = 700;
    private volatile boolean running = false;
    /** Last known pressed-state per key. Used to dedupe keyChanged
     *  emissions in polled mode where the device returns the full
     *  snapshot every tick — without this we'd flood JS with one
     *  keyChanged per key per tick (~32 × 33 Hz ≈ 1056 events/s). */
    private boolean[] lastKeyPressed;
    /** Last raw IN-report bytes. Used to dedupe rawInputReport debug
     *  events so the journal only shows transitions, not the polled
     *  snapshot stream. Crucial diagnostic: if NO line appears when
     *  the user presses a key in polled mode, GET_REPORT is returning
     *  cached data and polled is a dead end on that kernel. */
    private byte[] lastRawBytes;
    /** When true the reader thread emits a `rawInputReport` event for every
     * successful bulkTransfer (stripped to first 32 bytes hex). Off by
     * default — flips on via StreamDeckPlugin.setDebugLogging. */
    private static volatile boolean debugLogging = false;
    static void setDebugLogging(boolean v) { debugLogging = v; }

    /** Reader strategy. Some Android kernels shadow-consume the
     * interrupt-IN endpoint entirely; for those, GET_REPORT polling on
     * the control endpoint is the only path that delivers anything.
     *   - "userequest" — UsbRequest async on interrupt-IN. Default.
     *   - "bulk"       — bulkTransfer sync on interrupt-IN.
     *   - "polled"     — HID GET_REPORT control transfer @ ~30 Hz on
     *                    EP0. Never shadowed by kernel HID drivers
     *                    (control endpoint is shared infrastructure).
     * Takes effect on the next session open. */
    static final String READER_MODE_USEREQUEST = "userequest";
    static final String READER_MODE_BULK       = "bulk";
    static final String READER_MODE_POLLED     = "polled";
    private static volatile String readerMode = READER_MODE_USEREQUEST;
    static void setReaderMode(String v) {
        if (READER_MODE_USEREQUEST.equals(v)
            || READER_MODE_BULK.equals(v)
            || READER_MODE_POLLED.equals(v)) {
            readerMode = v;
        }
    }
    static String getReaderMode() { return readerMode; }
    // Back-compat with the old boolean toggle.
    static void setReaderUseBulk(boolean v) {
        readerMode = v ? READER_MODE_BULK : READER_MODE_USEREQUEST;
    }
    static boolean getReaderUseBulk() { return READER_MODE_BULK.equals(readerMode); }

    /** Polling period for the GET_REPORT path. ~33 Hz keeps perceived
     *  latency under 35 ms, well below the human reaction floor for a
     *  button press. Lower values eat more CPU and battery for no
     *  perceptible gain. */
    private static final int POLLED_INTERVAL_MS = 30;

    public DeckSession(DeckSpec spec, UsbDevice device, EventEmitter emitter) {
        this.spec = spec;
        this.device = device;
        this.emitter = emitter;
        this.transport = (spec.transport == DeckSpec.TransportKind.V1) ? new TransportV1() : new TransportV2();
        this.encoder = chooseEncoder(spec);
    }

    private static ImageEncoder chooseEncoder(DeckSpec spec) {
        switch (spec.keyImageFormat) {
            case JPEG:            return new JpegEncoder();
            case BMP_BGR_ROT180:  return new BmpEncoder(180);
            case BMP_BGR_ROT270:  return new BmpEncoder(270);
            default: throw new IllegalStateException("unknown format " + spec.keyImageFormat);
        }
    }

    public DeckSpec spec()   { return spec; }
    public UsbDevice device(){ return device; }
    public String serial()   { return serial; }
    public String firmware() { return firmware; }

    public synchronized void open(UsbManager usb) throws DeckOpenException {
        if (running) return;

        Log.i(TAG, "open: device=" + device.getDeviceName()
            + " interfaces=" + device.getInterfaceCount());

        // Find the HID interface.
        UsbInterface chosenIface = null;
        UsbEndpoint chosenIn = null, chosenOut = null;
        for (int i = 0; i < device.getInterfaceCount(); i++) {
            UsbInterface itf = device.getInterface(i);
            Log.i(TAG, "  iface[" + i + "] class=" + itf.getInterfaceClass()
                + " sub=" + itf.getInterfaceSubclass()
                + " proto=" + itf.getInterfaceProtocol()
                + " endpoints=" + itf.getEndpointCount());
            if (itf.getInterfaceClass() != UsbConstants.USB_CLASS_HID) continue;
            UsbEndpoint epi = null, epo = null;
            for (int e = 0; e < itf.getEndpointCount(); e++) {
                UsbEndpoint ep = itf.getEndpoint(e);
                Log.i(TAG, "    ep[" + e + "] addr=0x" + Integer.toHexString(ep.getAddress())
                    + " type=" + ep.getType()
                    + " dir=" + (ep.getDirection() == UsbConstants.USB_DIR_IN ? "IN" : "OUT")
                    + " maxPkt=" + ep.getMaxPacketSize());
                if (ep.getDirection() == UsbConstants.USB_DIR_IN)  epi = ep;
                if (ep.getDirection() == UsbConstants.USB_DIR_OUT) epo = ep;
            }
            if (epi != null && epo != null) {
                chosenIface = itf; chosenIn = epi; chosenOut = epo; break;
            }
        }
        if (chosenIface == null) throw new DeckOpenException("no_hid_interface");

        connection = usb.openDevice(device);
        if (connection == null) throw new DeckOpenException("open_failed");
        boolean claimed = connection.claimInterface(chosenIface, /*forceClaim=*/true);
        Log.i(TAG, "claimInterface(force=true) → " + claimed);
        if (!claimed) {
            connection.close();
            throw new DeckOpenException("interface_busy");
        }
        this.iface = chosenIface;
        this.epIn  = chosenIn;
        this.epOut = chosenOut;
        Log.i(TAG, "selected epIn=0x" + Integer.toHexString(epIn.getAddress())
            + " epOut=0x" + Integer.toHexString(epOut.getAddress())
            + " readerMode=" + readerMode);

        // HID class SET_IDLE 0 — tells the device to send reports only on
        // change, no idle re-transmission. On some Android kernels the
        // built-in HID driver auto-polls the IN endpoint and shadow-
        // consumes our reads; SET_IDLE 0 makes the device stop honouring
        // those polls so our reader gets the actual key-state reports.
        // Best-effort: a stall here is informational, not fatal.
        try {
            int sent = connection.controlTransfer(
                /*reqType=*/0x21, /*req=*/0x0A,
                /*value=*/0x0000, /*index=*/chosenIface.getId(),
                /*data=*/null, /*len=*/0,
                /*timeout=*/1000);
            Log.i(TAG, "SET_IDLE 0 → " + sent);
        } catch (Throwable t) {
            Log.w(TAG, "SET_IDLE failed (non-fatal): " + t.getMessage());
        }

        try {
            this.serial   = readSerial();
            this.firmware = readFirmware();
        } catch (Exception e) {
            Log.w(TAG, "feature read failed for " + device.getDeviceName(), e);
            this.serial = device.getSerialNumber() != null ? device.getSerialNumber() : "unknown";
            this.firmware = "unknown";
        }

        running = true;
        lastKeyPressed = new boolean[spec.keyCount];
        readerThread = new Thread(this::readerLoop, "deck-reader-" + serial);
        writerThread = new Thread(this::writerLoop, "deck-writer-" + serial);
        heartbeatThread = new Thread(this::heartbeatLoop, "deck-heartbeat-" + serial);
        readerThread.setDaemon(true);
        writerThread.setDaemon(true);
        heartbeatThread.setDaemon(true);
        readerThread.start();
        writerThread.start();
        heartbeatThread.start();

        emitLifecycle("deckConnected", null);
    }

    public synchronized void close(String reason) {
        if (!running) return;
        running = false;
        queue.closeAndDrainAsDropped();
        if (readerThread != null) readerThread.interrupt();
        if (writerThread != null) writerThread.interrupt();
        if (heartbeatThread != null) heartbeatThread.interrupt();
        if (connection != null) {
            try { connection.releaseInterface(iface); } catch (Exception ignored) {}
            try { connection.close(); } catch (Exception ignored) {}
        }
        emitLifecycle("deckDisconnected", reason);
    }

    public ImageEncoder encoder()   { return encoder; }
    public DeckTransport transport(){ return transport; }
    public WriterQueue queue()      { return queue; }

    /** Synchronously write all pages of a pre-paginated payload to the OUT endpoint. */
    public void writePages(List<byte[]> pages) throws DeckIoException {
        for (byte[] page : pages) {
            int sent = connection.bulkTransfer(epOut, page, page.length, BULK_WRITE_TIMEOUT_MS);
            if (sent != page.length) {
                throw new DeckIoException("bulk_write_short:" + sent + "/" + page.length);
            }
        }
    }

    /** Set brightness 0..100 via feature report. */
    public void setBrightness(int percent) throws DeckIoException {
        int p = Math.max(0, Math.min(100, percent));
        // Feature report: 0x03 0x08 <pct>. SET_REPORT request type 0x21,
        // request 0x09 (SET_REPORT), value (Feature << 8) | reportId.
        byte[] payload;
        if (spec.transport == DeckSpec.TransportKind.V2) {
            payload = new byte[32];
            payload[0] = 0x03; payload[1] = 0x08; payload[2] = (byte) p;
        } else {
            payload = new byte[17];
            payload[0] = 0x05; payload[1] = 0x55; payload[2] = (byte) 0xAA;
            payload[3] = (byte) 0xD1; payload[4] = 0x01; payload[5] = (byte) p;
        }
        int wValue = (0x03 << 8) | (payload[0] & 0xFF);
        int sent = connection.controlTransfer(0x21, 0x09, wValue, 0, payload, payload.length, 1000);
        if (sent < 0) throw new DeckIoException("set_brightness_failed:" + sent);
    }

    /** Reset (clear all key images) via feature report. */
    public void reset() throws DeckIoException {
        byte[] payload;
        if (spec.transport == DeckSpec.TransportKind.V2) {
            payload = new byte[32];
            payload[0] = 0x03; payload[1] = 0x02;
        } else {
            payload = new byte[17];
            payload[0] = 0x0B; payload[1] = 0x63;
        }
        int wValue = (0x03 << 8) | (payload[0] & 0xFF);
        int sent = connection.controlTransfer(0x21, 0x09, wValue, 0, payload, payload.length, 1000);
        if (sent < 0) throw new DeckIoException("reset_failed:" + sent);
    }

    /** Periodic GET_REPORT on EP0 to keep the USB bus visibly active.
     *  Without it, kernels implementing aggressive USB selective
     *  suspend (Pixel 6, Lenovo ThinkPhone, Motorola Edge 50 — observed
     *  on all three) stop sending SOFs after ~1 s of phone screen-off
     *  and the deck firmware pulses LCD brightness at ~1 Hz. The
     *  control transfer is read-only (firmware-version feature report)
     *  and shares no endpoint with the reader (which polls
     *  interrupt-IN) or the writer (which sends bulk-OUT), so the
     *  three threads don't contend.
     *
     *  Heartbeat failures are logged and swallowed — the deck might
     *  briefly hang during high writer queue pressure (e.g., camera
     *  streaming saturating bulk-OUT) and we don't want to tear the
     *  session down for what's almost always a transient stall. */
    private void heartbeatLoop() {
        int reportId = (spec.transport == DeckSpec.TransportKind.V2) ? 0x05 : 0x04;
        byte[] buf = new byte[32];
        while (running) {
            try {
                Thread.sleep(HEARTBEAT_MS);
            } catch (InterruptedException e) {
                return;
            }
            if (!running) return;
            try {
                connection.controlTransfer(0xa1, 0x01,
                    (0x03 << 8) | reportId, 0, buf, buf.length, 500);
            } catch (Throwable t) {
                Log.w(TAG, "heartbeat failed (continuing)", t);
            }
        }
    }

    private String readSerial() throws DeckIoException {
        // GET_REPORT (request type 0xa1, request 0x01), feature report ID per generation.
        byte[] buf = new byte[32];
        int reportId = (spec.transport == DeckSpec.TransportKind.V2) ? 0x06 : 0x03;
        int got = connection.controlTransfer(0xa1, 0x01, (0x03 << 8) | reportId, 0, buf, buf.length, 1000);
        if (got < 0) throw new DeckIoException("read_serial_failed:" + got);
        return parseAsciiAfterHeader(buf, /*headerLen=*/ (spec.transport == DeckSpec.TransportKind.V2) ? 2 : 5, got);
    }

    private String readFirmware() throws DeckIoException {
        byte[] buf = new byte[32];
        int reportId = (spec.transport == DeckSpec.TransportKind.V2) ? 0x05 : 0x04;
        int got = connection.controlTransfer(0xa1, 0x01, (0x03 << 8) | reportId, 0, buf, buf.length, 1000);
        if (got < 0) throw new DeckIoException("read_firmware_failed:" + got);
        return parseAsciiAfterHeader(buf, /*headerLen=*/ (spec.transport == DeckSpec.TransportKind.V2) ? 6 : 5, got);
    }

    private static String parseAsciiAfterHeader(byte[] buf, int headerLen, int totalLen) {
        StringBuilder sb = new StringBuilder();
        for (int i = headerLen; i < totalLen; i++) {
            byte b = buf[i];
            if (b == 0) break;
            if (b >= 0x20 && b < 0x7f) sb.append((char) b);
        }
        return sb.toString();
    }

    private void readerLoop() {
        // Reader path is selectable per-session via the static
        // readerMode flag. UsbRequest async works on most kernels; on
        // kernels where THAT is shadowed, bulk picks up the slack; on
        // kernels where BOTH interrupt-IN paths are dead, polled
        // GET_REPORT on the control endpoint sometimes works.
        switch (readerMode) {
            case READER_MODE_BULK:   readerLoopBulk();       break;
            case READER_MODE_POLLED: readerLoopPolled();     break;
            default:                 readerLoopUsbRequest();
        }
    }

    private void readerLoopUsbRequest() {
        UsbRequest req = new UsbRequest();
        if (!req.initialize(connection, epIn)) {
            Log.w(TAG, "UsbRequest.initialize failed for reader");
            close("usb_request_init_failed");
            return;
        }
        // The IN endpoint's max packet size is the only safe buffer size.
        // Stream Deck XL/Plus send 512-byte reports — using 64 bytes
        // returned EOVERFLOW (errno 75) on Pixel 6 / ThinkPhone kernels
        // and silent truncation on Motorola. Match the device.
        int bufSize = epIn != null ? epIn.getMaxPacketSize() : 64;
        if (bufSize < 64) bufSize = 64;
        ByteBuffer buf = ByteBuffer.allocate(bufSize);
        long lastDataAt = System.currentTimeMillis();
        long lastStarveLog = lastDataAt;

        try {
            while (running) {
                buf.clear();
                if (!req.queue(buf, buf.capacity())) {
                    if (!running) return;
                    Log.w(TAG, "UsbRequest.queue failed");
                    close("usb_request_queue_failed");
                    return;
                }
                UsbRequest finished = null;
                boolean timedOut = false;
                try {
                    finished = connection.requestWait(5000);
                } catch (java.util.concurrent.TimeoutException te) {
                    // requestWait(timeout) throws on timeout in API 26+;
                    // earlier API returns null. Either way it just means
                    // "nothing in the last 5 s" — NOT a fatal error.
                    timedOut = true;
                } catch (Throwable t) {
                    if (!running) return;
                    Log.w(TAG, "requestWait threw — closing", t);
                    close("usb_request_wait_threw:" + t.getClass().getSimpleName());
                    return;
                }
                if (!running) break;
                long now = System.currentTimeMillis();
                if (timedOut || finished == null) {
                    // Cancel the in-flight request before re-queueing.
                    // Without this, some Android kernels leave the
                    // request hanging in driver state and the next
                    // queue() call fails outright (we saw that on
                    // ThinkPhone after ~100 s of starvation).
                    try { req.cancel(); } catch (Throwable ignored) {}
                    if (now - lastStarveLog >= 5000) {
                        Log.w(TAG, "reader (UsbRequest) starving — "
                            + (now - lastDataAt) + " ms since last data");
                        lastStarveLog = now;
                        if (debugLogging) {
                            JSObject ev = new JSObject();
                            ev.put("deckId", serial);
                            ev.put("len", 0);
                            ev.put("bytes", "(starving UsbRequest "
                                + (now - lastDataAt) + "ms)");
                            emitter.emit("rawInputReport", ev);
                        }
                    }
                    continue;
                }
                int got = buf.position();
                if (got <= 0) continue;
                lastDataAt = now;

                byte[] data = new byte[got];
                buf.position(0);
                buf.get(data, 0, got);

                if (debugLogging) emitRaw(data, got);
                parseInputReport(data, got);
            }
        } finally {
            try { req.close(); } catch (Throwable ignored) {}
        }
    }

    private void readerLoopBulk() {
        // Sync read on the interrupt-IN endpoint. Shorter timeout (250 ms)
        // so the loop iterates often enough to react to running=false
        // and to surface starvation breadcrumbs. Buffer must match the
        // endpoint's max packet (512 on XL/Plus) — undersized buffers
        // return EOVERFLOW on stricter kernels (Pixel 6 / ThinkPhone).
        int bufSize = epIn != null ? epIn.getMaxPacketSize() : 64;
        if (bufSize < 64) bufSize = 64;
        byte[] buf = new byte[bufSize];
        long lastDataAt = System.currentTimeMillis();
        long lastStarveLog = lastDataAt;
        while (running) {
            int got;
            try {
                got = connection.bulkTransfer(epIn, buf, buf.length, 250);
            } catch (Throwable t) {
                if (!running) return;
                Log.w(TAG, "bulkTransfer threw — closing", t);
                close("bulk_read_threw:" + t.getClass().getSimpleName());
                return;
            }
            if (!running) break;
            long now = System.currentTimeMillis();
            if (got <= 0) {
                if (now - lastStarveLog >= 5000) {
                    Log.w(TAG, "reader (bulk) starving — "
                        + (now - lastDataAt) + " ms since last data");
                    lastStarveLog = now;
                    if (debugLogging) {
                        JSObject ev = new JSObject();
                        ev.put("deckId", serial);
                        ev.put("len", 0);
                        ev.put("bytes", "(starving bulk "
                            + (now - lastDataAt) + "ms)");
                        emitter.emit("rawInputReport", ev);
                    }
                }
                continue;
            }
            lastDataAt = now;
            byte[] data = new byte[got];
            System.arraycopy(buf, 0, data, 0, got);
            if (debugLogging) emitRaw(data, got);
            parseInputReport(data, got);
        }
    }

    /**
     * Poll the device's input report via HID class GET_REPORT on EP0.
     * Used as a last-resort path on phones whose kernel claims the
     * interrupt-IN endpoint and never lets userspace see a key event
     * (observed on Lenovo ThinkPhone). The control endpoint is shared
     * infrastructure that no kernel HID driver claims, so this path
     * always works at the cost of polling instead of waking on event.
     *
     * Effective rate is ~33 Hz which is well below human reaction time
     * floor for a button press, so latency is unnoticeable in practice.
     */
    private void readerLoopPolled() {
        // Stream Deck input reports vary in size by model; the buffer
        // sized to the IN endpoint's max packet ensures we always
        // read enough.
        int reportSize = epIn != null ? epIn.getMaxPacketSize() : 64;
        if (reportSize <= 0) reportSize = 64;
        byte[] buf = new byte[reportSize];
        long lastDataAt = System.currentTimeMillis();
        long lastStarveLog = lastDataAt;
        int ifaceId = iface != null ? iface.getId() : 0;
        // HID GET_REPORT: reqType 0xA1 (Class | Interface | IN), req 0x01,
        // value (Input=1 << 8 | reportId). Stream Deck input report id
        // is 0x01 across all the v1/v2 layouts we care about.
        final int reqType = 0xA1;
        final int req     = 0x01;
        final int wValue  = (0x01 << 8) | 0x01;
        // After a sustained starve (no data for >10 s), close the
        // session so the plugin can re-attach. Observed on Plus: GET_
        // REPORT on EP0 stops responding after ~3 s of polling and
        // never recovers without a fresh open. The hotplug retryAttach
        // / camera-streamer keepalive will reopen us within the second.
        final long STARVE_RESET_MS = 10000L;

        while (running) {
            int got;
            try {
                got = connection.controlTransfer(reqType, req, wValue, ifaceId,
                    buf, buf.length, 200);
            } catch (Throwable t) {
                if (!running) return;
                Log.w(TAG, "controlTransfer threw — closing", t);
                close("polled_threw:" + t.getClass().getSimpleName());
                return;
            }
            if (!running) break;
            long now = System.currentTimeMillis();
            if (got <= 0) {
                if (now - lastDataAt >= STARVE_RESET_MS) {
                    // Firmware almost certainly latched up — close so the
                    // plugin re-attaches us with a fresh GET_REPORT
                    // pipeline. Avoids the user having to mash Restart
                    // Sessions every 10 s.
                    Log.w(TAG, "reader (polled) starved past reset threshold ("
                        + (now - lastDataAt) + " ms) — closing for re-attach");
                    close("polled_reset");
                    return;
                }
                if (now - lastStarveLog >= 5000) {
                    Log.w(TAG, "reader (polled) starving — "
                        + (now - lastDataAt) + " ms since last data, last got=" + got);
                    lastStarveLog = now;
                    if (debugLogging) {
                        JSObject ev = new JSObject();
                        ev.put("deckId", serial);
                        ev.put("len", got);
                        ev.put("bytes", "(starving polled, last=" + got + ")");
                        emitter.emit("rawInputReport", ev);
                    }
                }
                sleepQuiet(POLLED_INTERVAL_MS);
                continue;
            }
            lastDataAt = now;
            byte[] data = new byte[got];
            System.arraycopy(buf, 0, data, 0, got);
            if (debugLogging) emitRaw(data, got);
            parseInputReport(data, got);
            sleepQuiet(POLLED_INTERVAL_MS);
        }
    }

    private static void sleepQuiet(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) { /* loop will exit on running=false */ }
    }

    /**
     * Native USBDEVFS reader path. Uses ioctl(USBDEVFS_DISCONNECT) to
     * detach any in-kernel HID driver from the interface BEFORE we
     * claim it — this is the part Java's claimInterface(force=true)
     * does not do, and the reason interrupt-IN reads silently return
     * nothing on certain phone kernels (Lenovo ThinkPhone, Pixel 6).
     *
     * If the native lib isn't loaded (build skipped or arch mismatch),
     * we fall through to the UsbRequest path so the session still
     * works with output-only.
     */
    private void emitRaw(byte[] data, int got) {
        // Dedupe — only emit when bytes actually changed since the
        // last report. Polled mode floods us with the same snapshot
        // every tick; the journal stays empty until something moves.
        if (lastRawBytes != null && lastRawBytes.length == got) {
            boolean same = true;
            for (int i = 0; i < got; i++) {
                if (lastRawBytes[i] != data[i]) { same = false; break; }
            }
            if (same) return;
        }
        if (lastRawBytes == null || lastRawBytes.length != got) {
            lastRawBytes = new byte[got];
        }
        System.arraycopy(data, 0, lastRawBytes, 0, got);

        StringBuilder sb = new StringBuilder();
        int dump = Math.min(got, 32);
        for (int i = 0; i < dump; i++) {
            if (i > 0) sb.append(" ");
            sb.append(String.format("%02x", data[i] & 0xFF));
        }
        if (got > dump) sb.append(" …");
        // Log to logcat too so adb tcpip captures the diagnostic
        // even when the user can't see the in-app journal.
        Log.i(TAG, "raw[" + got + "]: " + sb);
        JSObject ev = new JSObject();
        ev.put("deckId", serial);
        ev.put("len", got);
        ev.put("bytes", sb.toString());
        emitter.emit("rawInputReport", ev);
    }

    /**
     * Parse one HID IN report. Layout differs per model — this dispatch handles
     * the common cases. Detailed offsets must be cross-checked against
     * python-elgato-streamdeck during integration testing.
     *
     * v1: report id 0x01 followed by 1 byte per key (1=pressed, 0=not).
     * v2+ keys: 0x01 0x00 <pad> followed by 1 byte per key.
     * Plus dial: 0x01 0x03 ...
     * Plus lcd touch: 0x01 0x02 ...
     * Neo touch: 0x01 0x04 ...
     */
    private void parseInputReport(byte[] buf, int len) {
        if (len < 2) return;
        int reportId = buf[0] & 0xFF;
        int subType = buf[1] & 0xFF;

        // Decks WITH multiple report kinds (Plus, Neo) discriminate via byte 1
        // (0x00=keys, 0x02=lcd touch, 0x03=dial, 0x04=neo touch). Decks
        // WITHOUT (XL, MK.2, Original v2, Mini, Original v1) just emit a
        // key report under reportId 0x01 — byte 1 is part of the header
        // and can be anything.
        boolean hasReportSubtypes = spec.dialCount > 0 || spec.touchPoints > 0;
        boolean isKeyReport = reportId == 0x01
            && (!hasReportSubtypes || subType == 0x00);

        if (isKeyReport) {
            // Key report. Keys start at offset 4 for V2, 1 for V1.
            // Polled mode delivers the full snapshot every tick; dedupe
            // against lastKeyPressed so JS only sees actual transitions.
            // Interrupt modes also benefit — the firmware sometimes
            // resends the same delta if a tick is dropped.
            int offset = (spec.transport == DeckSpec.TransportKind.V2) ? 4 : 1;
            for (int k = 0; k < spec.keyCount; k++) {
                if (offset + k >= len) break;
                boolean pressed = buf[offset + k] != 0;
                if (lastKeyPressed != null
                    && k < lastKeyPressed.length
                    && lastKeyPressed[k] == pressed) {
                    continue;
                }
                if (lastKeyPressed != null && k < lastKeyPressed.length) {
                    lastKeyPressed[k] = pressed;
                }
                JSObject ev = new JSObject();
                ev.put("deckId", serial);
                ev.put("key", k);
                ev.put("pressed", pressed);
                emitter.emit("keyChanged", ev);
            }
        } else if (reportId == 0x01 && subType == 0x03 && spec.dialCount > 0) {
            // Plus dial. byte 4 = type (0=press, 1=rotate); subsequent bytes per dial.
            int kind = buf[4] & 0xFF;
            for (int d = 0; d < spec.dialCount; d++) {
                int v = buf[5 + d] & 0xFF;
                if (kind == 0x00) {
                    JSObject ev = new JSObject();
                    ev.put("deckId", serial);
                    ev.put("dial", d);
                    ev.put("pressed", v != 0);
                    emitter.emit("dialPressed", ev);
                } else if (kind == 0x01) {
                    int delta = (v >= 0x80) ? v - 0x100 : v;
                    if (delta == 0) continue;
                    JSObject ev = new JSObject();
                    ev.put("deckId", serial);
                    ev.put("dial", d);
                    ev.put("delta", delta);
                    emitter.emit("dialRotated", ev);
                }
            }
        } else if (reportId == 0x01 && subType == 0x02 && spec.lcdW > 0) {
            // Plus LCD touch. byte 4 = kind (1=short, 2=long, 3=drag).
            int kind = buf[4] & 0xFF;
            int x = (buf[6] & 0xFF) | ((buf[7] & 0xFF) << 8);
            int y = (buf[8] & 0xFF) | ((buf[9] & 0xFF) << 8);
            JSObject ev = new JSObject();
            ev.put("deckId", serial);
            ev.put("type", kind == 1 ? "short" : kind == 2 ? "long" : "drag");
            ev.put("x", x);
            ev.put("y", y);
            if (kind == 3) {
                int xe = (buf[10] & 0xFF) | ((buf[11] & 0xFF) << 8);
                int ye = (buf[12] & 0xFF) | ((buf[13] & 0xFF) << 8);
                ev.put("xEnd", xe); ev.put("yEnd", ye);
            }
            emitter.emit("lcdTouched", ev);
        } else if (reportId == 0x01 && subType == 0x04 && spec.touchPoints > 0) {
            // Neo touch points. Byte 5 = bitmask.
            int mask = buf[5] & 0xFF;
            for (int t = 0; t < spec.touchPoints; t++) {
                JSObject ev = new JSObject();
                ev.put("deckId", serial);
                ev.put("index", t);
                ev.put("pressed", (mask & (1 << t)) != 0);
                emitter.emit("neoTouched", ev);
            }
        }
    }

    private void writerLoop() {
        while (running) {
            try {
                WriteJob job = queue.take();
                if (!running) return;
                job.runTransport();
            } catch (InterruptedException e) {
                return; // closed
            } catch (Throwable t) {
                Log.w(TAG, "writer job error", t);
            }
        }
    }

    private void emitLifecycle(String name, String reason) {
        JSObject ev = new JSObject();
        ev.put("deckId", serial);
        if (reason != null) ev.put("reason", reason);
        emitter.emit(name, ev);
    }

    public static final class DeckOpenException extends Exception {
        public DeckOpenException(String msg) { super(msg); }
    }

    public static final class DeckIoException extends Exception {
        public DeckIoException(String msg) { super(msg); }
    }
}
