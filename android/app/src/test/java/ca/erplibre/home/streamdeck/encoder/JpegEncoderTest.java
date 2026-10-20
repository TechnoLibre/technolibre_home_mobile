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
