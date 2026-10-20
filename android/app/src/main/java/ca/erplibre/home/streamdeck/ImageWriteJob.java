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
    /** True when inputBytes are already in the wire format (a blank key). */
    private final boolean encoded;
    private final PluginCall call;

    ImageWriteJob(DeckSession session, int keyIndex, byte[] inputBytes, PluginCall call) {
        this(session, keyIndex, inputBytes, false, call);
    }

    private ImageWriteJob(DeckSession session, int keyIndex, byte[] inputBytes,
                          boolean encoded, PluginCall call) {
        this.session = session;
        this.keyIndex = keyIndex;
        this.inputBytes = inputBytes;
        this.encoded = encoded;
        this.call = call;
    }

    /** Writes {@code wireBytes} as they are, skipping the encoder. */
    static ImageWriteJob preEncoded(DeckSession session, int keyIndex, byte[] wireBytes,
                                    PluginCall call) {
        return new ImageWriteJob(session, keyIndex, wireBytes, true, call);
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
            byte[] wire = encoded ? inputBytes
                : enc.encode(inputBytes, session.spec().keyImageW, session.spec().keyImageH);
            DeckTransport tx = session.transport();
            List<byte[]> pages = tx.paginateKeyImage(keyIndex, wire);
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
