package ca.erplibre.home.streamdeck.encoder;

import static org.junit.Assert.*;
import org.junit.Test;

import ca.erplibre.home.streamdeck.encoder.ImageEncoder.ImageEncodeException;

public class JpegEncoderTest {

    private static String rejection(byte[] input) {
        try {
            new JpegEncoder().encode(input, 72, 72);
        } catch (ImageEncodeException e) {
            return e.getMessage();
        }
        fail("expected a rejection");
        return null;
    }

    // ── passthrough ────────────────────────────────────────────────────

    /** TypeScript draws, rotates and compresses the key; Java only checks
     *  the magic bytes, whatever the target size. */
    @Test
    public void jpeg_goes_through_unchanged() throws Exception {
        byte[] jpeg = ImageHeaderTest.jpeg(96, 96);
        byte[] copy = jpeg.clone();
        assertArrayEquals(copy, new JpegEncoder().encode(jpeg, 72, 72));
        assertArrayEquals(copy, new JpegEncoder().encode(jpeg, 120, 120));
        assertEquals("jpeg", new JpegEncoder().inputFormat());
    }

    // ── blank keys ─────────────────────────────────────────────────────

    /** SHA-256 of BLANK_KEY_IMAGE in python-elgato-streamdeck:
     *  StreamDeckOriginalV2 (also MK.2) at 72, StreamDeckXL and
     *  StreamDeckNeo at 96, StreamDeckPlus at 120. */
    @Test
    public void blank_keys_are_the_python_blank_key_images() throws Exception {
        JpegEncoder enc = new JpegEncoder();
        assertEquals("772a2a9e83e9622071a7bc2350b8ef317fdfa6edd8a74d449fdd317c50d2ee8d",
            BmpEncoderTest.sha256(enc.blank(72, 72)));
        assertEquals("0c549a49d707c43c9f9e1f61c4262f7319647e1292663192dae4006a16bd256c",
            BmpEncoderTest.sha256(enc.blank(96, 96)));
        assertEquals("787b843ce79247a29c96856b3e40221b65a8aa8c9d1e058d9692afc1381fae7e",
            BmpEncoderTest.sha256(enc.blank(120, 120)));
    }

    @Test
    public void blank_is_a_copy_the_caller_may_change() throws Exception {
        JpegEncoder enc = new JpegEncoder();
        byte[] first = enc.blank(72, 72);
        first[first.length - 1] = 0;
        assertEquals(0xD9, enc.blank(72, 72)[first.length - 1] & 0xFF);
    }

    @Test
    public void blank_of_a_size_no_model_has_is_refused() {
        assertEquals("unsupported:blank_key_size:50x50", blankRejection(50, 50));
        assertEquals("unsupported:blank_key_size:72x96", blankRejection(72, 96));
    }

    private static String blankRejection(int w, int h) {
        try {
            new JpegEncoder().blank(w, h);
        } catch (ImageEncodeException e) {
            return e.getMessage();
        }
        fail("expected a rejection");
        return null;
    }

    // ── rejections ─────────────────────────────────────────────────────

    @Test
    public void png_on_a_jpeg_model_says_the_model_wants_jpeg() {
        assertEquals("format_mismatch:jpeg_model_requires_jpeg",
            rejection(ImageHeaderTest.png(72, 72)));
    }

    @Test
    public void bytes_of_no_known_format_say_the_model_wants_jpeg() {
        assertEquals("format_mismatch:jpeg_model_requires_jpeg",
            rejection(new byte[] { 'B', 'M', 0, 0 }));
    }

    @Test
    public void empty_or_truncated_input_is_a_decode_failure() {
        assertEquals("image_decode_failed:empty_or_truncated", rejection(null));
        assertEquals("image_decode_failed:empty_or_truncated", rejection(new byte[] { (byte) 0xFF, (byte) 0xD8 }));
    }
}
