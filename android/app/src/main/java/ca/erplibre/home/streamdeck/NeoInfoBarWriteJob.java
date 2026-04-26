package ca.erplibre.home.streamdeck;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

import java.util.List;

import ca.erplibre.home.streamdeck.lcd.LcdEncoder;

/**
 * Writes the Neo info screen (248x58 JPEG, command 0x0B). The Neo physically
 * has a single screen — the {@code index} parameter exists in the public API
 * for forward compatibility but only index 0 is currently meaningful.
 *
 * Validation of {@code index} happens in StreamDeckPlugin before this job is
 * queued; here we just paginate and write.
 */
final class NeoInfoBarWriteJob extends WriteJob {

    private final DeckSession session;
    private final int index;
    private final byte[] jpegBytes;
    private final PluginCall call;

    NeoInfoBarWriteJob(DeckSession session, int index, byte[] jpegBytes, PluginCall call) {
        this.session = session;
        this.index = index;
        this.jpegBytes = jpegBytes;
        this.call = call;
    }

    @Override public String slotKey() { return "infobar:" + index; }

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
                call.reject("image_decode_failed:infobar_requires_jpeg");
                return;
            }
            List<byte[]> pages = LcdEncoder.paginateNeoScreen(jpegBytes);
            session.writePages(pages);
            JSObject r = new JSObject();
            r.put("dropped", false);
            call.resolve(r);
        } catch (IllegalArgumentException e) {
            call.reject("image_oversized:" + e.getMessage());
        } catch (DeckSession.DeckIoException e) {
            call.reject(e.getMessage());
        } catch (Throwable t) {
            call.reject("infobar_write_failed:" + t.getMessage());
        }
    }
}
