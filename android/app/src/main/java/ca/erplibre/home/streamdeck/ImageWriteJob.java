package ca.erplibre.home.streamdeck;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

import java.util.List;

import ca.erplibre.home.streamdeck.encoder.ImageEncoder;
import ca.erplibre.home.streamdeck.transport.DeckTransport;

/** Writes one key image: encode → paginate → write pages. Resolves the PluginCall.
 *  When call is null, the job is fire-and-forget (used by setKeyImagesBatch
 *  during camera streaming where 32 per-key resolves would just be JNI noise). */
final class ImageWriteJob extends WriteJob {

    private final DeckSession session;
    private final int keyIndex;
    private final byte[] inputBytes;
    private final PluginCall call;

    ImageWriteJob(DeckSession session, int keyIndex, byte[] inputBytes, PluginCall call) {
        this.session = session;
        this.keyIndex = keyIndex;
        this.inputBytes = inputBytes;
        this.call = call;
    }

    @Override public String slotKey() { return "key:" + keyIndex; }

    @Override public void resolveDropped() {
        if (call == null) return;
        JSObject r = new JSObject();
        r.put("dropped", true);
        call.resolve(r);
    }

    @Override
    public void runTransport() {
        try {
            ImageEncoder enc = session.encoder();
            byte[] encoded = enc.encode(inputBytes, session.spec().keyImageW, session.spec().keyImageH);
            DeckTransport tx = session.transport();
            List<byte[]> pages = tx.paginateKeyImage(keyIndex, encoded);
            session.writePages(pages);
            if (call != null) {
                JSObject r = new JSObject();
                r.put("dropped", false);
                call.resolve(r);
            }
        } catch (ImageEncoder.ImageEncodeException e) {
            if (call != null) call.reject(e.getMessage());
        } catch (DeckSession.DeckIoException e) {
            if (call != null) call.reject(e.getMessage());
        } catch (Throwable t) {
            if (call != null) call.reject("image_write_failed:" + t.getMessage());
        }
    }
}
