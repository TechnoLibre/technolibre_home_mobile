package ca.erplibre.home.streamdeck;

import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.util.Log;

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
    private volatile boolean running = false;
    /** When true the reader thread emits a `rawInputReport` event for every
     * successful bulkTransfer (stripped to first 32 bytes hex). Off by
     * default — flips on via StreamDeckPlugin.setDebugLogging. */
    private static volatile boolean debugLogging = false;
    static void setDebugLogging(boolean v) { debugLogging = v; }

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

        // Find the HID interface.
        UsbInterface chosenIface = null;
        UsbEndpoint chosenIn = null, chosenOut = null;
        for (int i = 0; i < device.getInterfaceCount(); i++) {
            UsbInterface itf = device.getInterface(i);
            if (itf.getInterfaceClass() != UsbConstants.USB_CLASS_HID) continue;
            UsbEndpoint epi = null, epo = null;
            for (int e = 0; e < itf.getEndpointCount(); e++) {
                UsbEndpoint ep = itf.getEndpoint(e);
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
        if (!connection.claimInterface(chosenIface, /*forceClaim=*/true)) {
            connection.close();
            throw new DeckOpenException("interface_busy");
        }
        this.iface = chosenIface;
        this.epIn  = chosenIn;
        this.epOut = chosenOut;

        try {
            this.serial   = readSerial();
            this.firmware = readFirmware();
        } catch (Exception e) {
            Log.w(TAG, "feature read failed for " + device.getDeviceName(), e);
            this.serial = device.getSerialNumber() != null ? device.getSerialNumber() : "unknown";
            this.firmware = "unknown";
        }

        running = true;
        readerThread = new Thread(this::readerLoop, "deck-reader-" + serial);
        writerThread = new Thread(this::writerLoop, "deck-writer-" + serial);
        readerThread.setDaemon(true);
        writerThread.setDaemon(true);
        readerThread.start();
        writerThread.start();

        emitLifecycle("deckConnected", null);
    }

    public synchronized void close(String reason) {
        if (!running) return;
        running = false;
        queue.closeAndDrainAsDropped();
        if (readerThread != null) readerThread.interrupt();
        if (writerThread != null) writerThread.interrupt();
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
        // Buffer sized to spec's HID input report length (inferred from python lib;
        // safe upper bound covers all models).
        byte[] buf = new byte[64];
        while (running) {
            int got = connection.bulkTransfer(epIn, buf, buf.length, BULK_READ_TIMEOUT_MS);
            if (!running) break;
            if (got < 0) {
                // timeout (continue) or error (disconnect).
                if (got == -1) continue; // common timeout return on Android USB stack
                Log.w(TAG, "reader bulkTransfer error " + got + " — closing session");
                close("usb_lost");
                return;
            }
            if (debugLogging) {
                StringBuilder sb = new StringBuilder();
                int dump = Math.min(got, 32);
                for (int i = 0; i < dump; i++) {
                    if (i > 0) sb.append(" ");
                    sb.append(String.format("%02x", buf[i] & 0xFF));
                }
                if (got > dump) sb.append(" …");
                JSObject ev = new JSObject();
                ev.put("deckId", serial);
                ev.put("len", got);
                ev.put("bytes", sb.toString());
                emitter.emit("rawInputReport", ev);
            }
            parseInputReport(buf, got);
        }
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
            int offset = (spec.transport == DeckSpec.TransportKind.V2) ? 4 : 1;
            for (int k = 0; k < spec.keyCount; k++) {
                if (offset + k >= len) break;
                boolean pressed = buf[offset + k] != 0;
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
