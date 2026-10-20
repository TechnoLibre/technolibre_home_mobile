package ca.erplibre.home.streamdeck.encoder;

import static org.junit.Assert.*;
import org.junit.Test;

public class ImageHeaderTest {

    /** SOI, an APP0 segment, then a baseline SOF0 for {@code w}×{@code h}. */
    public static byte[] jpeg(int w, int h) {
        return new byte[] {
            (byte) 0xFF, (byte) 0xD8,
            (byte) 0xFF, (byte) 0xE0, 0, 6, 'J', 'F', 'I', 'F',
            (byte) 0xFF, (byte) 0xC0, 0, 17, 8,
            (byte) (h >> 8), (byte) h, (byte) (w >> 8), (byte) w,
            3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
        };
    }

    /** PNG signature and the start of an IHDR chunk for {@code w}×{@code h}. */
    public static byte[] png(int w, int h) {
        return new byte[] {
            (byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A,
            0, 0, 0, 13, 'I', 'H', 'D', 'R',
            (byte) (w >> 24), (byte) (w >> 16), (byte) (w >> 8), (byte) w,
            (byte) (h >> 24), (byte) (h >> 16), (byte) (h >> 8), (byte) h,
            8, 6, 0, 0, 0,
        };
    }

    @Test
    public void reads_jpeg_sof0_after_other_segments() {
        assertArrayEquals(new int[] { 120, 72 }, ImageHeader.dimensions(jpeg(120, 72)));
    }

    @Test
    public void reads_png_ihdr() {
        assertArrayEquals(new int[] { 80, 160 },
            ImageHeader.dimensions(png(80, 160)));
    }

    @Test
    public void unknown_or_truncated_input_has_no_dimensions() {
        assertNull(ImageHeader.dimensions(new byte[0]));
        assertNull(ImageHeader.dimensions(new byte[] { (byte) 0xFF, (byte) 0xD8 }));
        assertNull(ImageHeader.dimensions(new byte[] { (byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xE0, 0, 40 }));
        assertNull(ImageHeader.dimensions(new byte[] { 'G', 'I', 'F', '8', '9', 'a' }));
    }

    @Test
    public void jpeg_dht_marker_is_not_taken_for_a_frame() {
        // 0xC4 (DHT) sits in the SOF range but carries no dimensions.
        byte[] b = {
            (byte) 0xFF, (byte) 0xD8,
            (byte) 0xFF, (byte) 0xC4, 0, 7, 0x11, 0x00, 0x01, 0x00, 0x00,
            (byte) 0xFF, (byte) 0xC0, 0, 11, 8, 0, 9, 0, 10, 1, 1, 0x11, 0,
        };
        assertArrayEquals(new int[] { 10, 9 }, ImageHeader.dimensions(b));
    }
}
