package ca.erplibre.home.streamdeck.encoder;

/**
 * Converts a TS-supplied image (JPEG or PNG bytes) into the model's
 * on-the-wire format ready for transport pagination.
 *
 * Implementations are stateless and shareable across decks of the same model.
 */
public interface ImageEncoder {
    /** Indicates which input format this encoder accepts ("jpeg" or "png"). */
    String inputFormat();

    /** Produces the bytes the deck wants on the wire (pre-pagination). */
    byte[] encode(byte[] inputBytes, int targetW, int targetH) throws ImageEncodeException;

    final class ImageEncodeException extends Exception {
        public ImageEncodeException(String msg) { super(msg); }
        public ImageEncodeException(String msg, Throwable cause) { super(msg, cause); }
    }
}
