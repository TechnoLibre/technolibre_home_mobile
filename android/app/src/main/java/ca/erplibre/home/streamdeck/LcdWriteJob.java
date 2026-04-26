package ca.erplibre.home.streamdeck;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

import java.util.List;

import ca.erplibre.home.streamdeck.lcd.LcdEncoder;

/**
 * Writes one Plus LCD region (full or partial). LCD bytes are JPEG already
 * (TS rendered them via Canvas), so there is no encode step — straight to
 * pagination + bulk OUT writes.
 */
final class LcdWriteJob extends WriteJob {

    private final DeckSession session;
    private final int x, y, w, h;
    private final byte[] jpegBytes;
    private final PluginCall call;
    private final String slotKey;

    LcdWriteJob(DeckSession session, int x, int y, int w, int h, byte[] jpegBytes,
                PluginCall call, String slotKey) {
        this.session = session;
        this.x = x; this.y = y; this.w = w; this.h = h;
        this.jpegBytes = jpegBytes;
        this.call = call;
        this.slotKey = slotKey;
    }

    @Override public String slotKey() { return slotKey; }

    @Override public void resolveDropped() {
        JSObject r = new JSObject();
        r.put("dropped", true);
        call.resolve(r);
    }

    @Override
    public void runTransport() {
        try {
            if (jpegBytes.length < 3
                    || (jpegBytes[0] & 0xFF) != 0xFF
                    || (jpegBytes[1] & 0xFF) != 0xD8
                    || (jpegBytes[2] & 0xFF) != 0xFF) {
                call.reject("image_decode_failed:lcd_requires_jpeg");
                return;
            }
            List<byte[]> pages = LcdEncoder.paginatePlusLcd(x, y, w, h, jpegBytes);
            session.writePages(pages);
            JSObject r = new JSObject();
            r.put("dropped", false);
            call.resolve(r);
        } catch (IllegalArgumentException e) {
            call.reject("image_oversized:" + e.getMessage());
        } catch (DeckSession.DeckIoException e) {
            call.reject(e.getMessage());
        } catch (Throwable t) {
            call.reject("lcd_write_failed:" + t.getMessage());
        }
    }
}
