package ca.erplibre.home.streamdeck;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

import java.util.List;

import ca.erplibre.home.streamdeck.encoder.ImageEncoder;
import ca.erplibre.home.streamdeck.transport.DeckTransport;

/** Writes one key image: encode → paginate → write pages. Resolves the PluginCall.
 *  When call is null, the job is fire-and-forget (used by setKeyImagesBatch
 *  during camera streaming where 32 per-key resolves would just be JNI noise):
 *  its failures go out as writeFailed events instead of rejections. */
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
    public void runTransport() throws DeckSession.DeckIoException {
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
            } else {
                session.writeSucceeded(keyIndex);
            }
        } catch (ImageEncoder.ImageEncodeException e) {
            fail(e.getMessage());
        } catch (DeckSession.DeckIoException e) {
            // The session closes on this; deckDisconnected carries the
            // detail for a fire-and-forget job.
            if (call != null) call.reject(e.getMessage());
            throw e;
        } catch (Throwable t) {
            fail("image_write_failed:" + t.getMessage());
        }
    }

    /** Rejects the caller, or reports to JS when there is none. */
    private void fail(String reason) {
        if (call != null) call.reject(reason);
        else session.reportWriteFailure(keyIndex, reason);
    }
}
