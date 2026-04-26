package ca.erplibre.home.streamdeck.encoder;

import ca.erplibre.home.streamdeck.encoder.ImageEncoder.ImageEncodeException;

/**
 * Identity encoder for v2+ Stream Decks: TypeScript renders to <canvas> and
 * exports JPEG via canvas.toBlob('image/jpeg'). Java only forwards the bytes
 * to the transport pagination stage.
 *
 * The encoder validates the JPEG magic bytes to fail fast on malformed input.
 */
public final class JpegEncoder implements ImageEncoder {

    @Override public String inputFormat() { return "jpeg"; }

    @Override
    public byte[] encode(byte[] inputBytes, int targetW, int targetH) throws ImageEncodeException {
        if (inputBytes == null || inputBytes.length < 3) {
            throw new ImageEncodeException("image_decode_failed:empty_or_truncated");
        }
        if ((inputBytes[0] & 0xFF) != 0xFF || (inputBytes[1] & 0xFF) != 0xD8 || (inputBytes[2] & 0xFF) != 0xFF) {
            throw new ImageEncodeException("format_mismatch:bmp_model_requires_png");
        }
        return inputBytes;
    }
}
