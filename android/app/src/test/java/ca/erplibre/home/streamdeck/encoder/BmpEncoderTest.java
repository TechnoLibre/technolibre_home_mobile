package ca.erplibre.home.streamdeck.encoder;

import static org.junit.Assert.*;
import org.junit.Test;

import java.security.MessageDigest;

import ca.erplibre.home.streamdeck.encoder.ImageEncoder.ImageEncodeException;

/**
 * BmpEncoder against python-elgato-streamdeck, the reference driver: the
 * golden digests are the bytes its PILHelper._to_native_format writes for
 * the same fixture (Pillow BMP, the model's KEY_ROTATION and KEY_FLIP).
 * The PNG decode in encode() needs android.graphics and is not run here;
 * encodeArgb() is everything after it.
 */
public class BmpEncoderTest {

    /** R = 3x, G = 3y, B = x + 2y (each mod 256): every pixel of a key
     *  size is distinct, so any misplaced row or column changes the digest. */
    static int[] fixture(int n) {
        int[] argb = new int[n * n];
        for (int y = 0; y < n; y++) {
            for (int x = 0; x < n; x++) {
                int r = (x * 3) & 0xFF, g = (y * 3) & 0xFF, b = (x + 2 * y) & 0xFF;
                argb[y * n + x] = 0xFF000000 | (r << 16) | (g << 8) | b;
            }
        }
        return argb;
    }

    // ── golden output per model family ─────────────────────────────────

    @Test
    public void original_v1_matches_the_python_library_byte_for_byte() {
        byte[] bmp = new BmpEncoder(180).encodeArgb(fixture(72), 72, 72);
        assertEquals(15606, bmp.length);
        assertEquals("c9c25e8ca269a37ce08a499d2233ca50a7211ccd90ecc641e67769e913d87717", sha256(bmp));
    }

    @Test
    public void mini_matches_the_python_library_byte_for_byte() {
        byte[] bmp = new BmpEncoder(270).encodeArgb(fixture(80), 80, 80);
        assertEquals(19254, bmp.length);
        assertEquals("56c7816eda20f886367e30de130a375ceb5f6ed42d264fd5b0b69f1b7e5d28f1", sha256(bmp));
    }

    /** The first pixel on the wire is the top-right one of the drawn key
     *  on both models: the v1 flips both axes and stores rows bottom-up;
     *  the Mini rotates 90° counterclockwise, flips vertically, and stores
     *  rows bottom-up. */
    @Test
    public void first_pixel_on_the_wire_is_the_top_right_of_the_drawing() {
        byte[] v1 = new BmpEncoder(180).encodeArgb(fixture(72), 72, 72);
        assertPixel(v1, 54, 71 * 3, 0, 71);
        byte[] mini = new BmpEncoder(270).encodeArgb(fixture(80), 80, 80);
        assertPixel(mini, 54, (79 * 3) & 0xFF, 0, 79);
    }

    // ── header ─────────────────────────────────────────────────────────

    @Test
    public void header_is_the_pillow_bitmapinfoheader() {
        byte[] bmp = new BmpEncoder(180).encodeArgb(fixture(72), 72, 72);
        assertEquals('B', bmp[0]);
        assertEquals('M', bmp[1]);
        assertEquals(15606, le32(bmp, 2));   // file size
        assertEquals(54, le32(bmp, 10));     // pixel offset
        assertEquals(40, le32(bmp, 14));     // BITMAPINFOHEADER
        assertEquals(72, le32(bmp, 18));
        assertEquals(72, le32(bmp, 22));     // positive: rows bottom-up
        assertEquals(24, le16(bmp, 28));
        assertEquals(15552, le32(bmp, 34));
        assertEquals(3780, le32(bmp, 38));   // 96 dpi
        assertEquals(3780, le32(bmp, 42));
    }

    @Test
    public void blank_v1_key_is_the_python_blank_key_image() {
        assertEquals("45a04b86642c8d18425c53772dbbb223dee9bb195bbca643f7fcb36ed74d06a4",
            sha256(new BmpEncoder(180).blank(72, 72)));
    }

    @Test
    public void blank_mini_key_declares_its_own_size() {
        // python-elgato-streamdeck's Mini blank reuses the 72x72 header of
        // the Original; the deck reads 80x80 pixels either way.
        byte[] blank = new BmpEncoder(270).blank(80, 80);
        assertEquals(80, le32(blank, 18));
        assertEquals(80, le32(blank, 22));
        assertEquals(54 + 80 * 80 * 3, blank.length);
    }

    // ── rejections ─────────────────────────────────────────────────────

    @Test
    public void takes_png() {
        assertEquals("png", new BmpEncoder(180).inputFormat());
        assertEquals("png", new BmpEncoder(270).inputFormat());
    }

    @Test(expected = IllegalArgumentException.class)
    public void rotation_other_than_a_bmp_model_is_refused() {
        new BmpEncoder(90);
    }

    @Test
    public void jpeg_on_a_bmp_model_says_the_model_wants_png() {
        assertEquals("format_mismatch:bmp_model_requires_png",
            rejection(ImageHeaderTest.jpeg(72, 72)));
    }

    @Test
    public void empty_or_truncated_input_is_a_decode_failure() {
        assertEquals("image_decode_failed:empty_or_truncated", rejection(null));
        assertEquals("image_decode_failed:empty_or_truncated", rejection(new byte[] { (byte) 0x89, 'P', 'N', 'G' }));
    }

    private static String rejection(byte[] input) {
        try {
            new BmpEncoder(180).encode(input, 72, 72);
        } catch (ImageEncodeException e) {
            return e.getMessage();
        }
        fail("expected a rejection");
        return null;
    }

    private static void assertPixel(byte[] bmp, int off, int r, int g, int b) {
        assertEquals("B", b, bmp[off] & 0xFF);
        assertEquals("G", g, bmp[off + 1] & 0xFF);
        assertEquals("R", r, bmp[off + 2] & 0xFF);
    }

    static String sha256(byte[] data) {
        try {
            StringBuilder sb = new StringBuilder();
            for (byte x : MessageDigest.getInstance("SHA-256").digest(data)) sb.append(String.format("%02x", x & 0xFF));
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new AssertionError(e);
        }
    }

    private static int le32(byte[] b, int off) {
        return (b[off] & 0xFF) | ((b[off + 1] & 0xFF) << 8)
            | ((b[off + 2] & 0xFF) << 16) | ((b[off + 3] & 0xFF) << 24);
    }

    private static int le16(byte[] b, int off) {
        return (b[off] & 0xFF) | ((b[off + 1] & 0xFF) << 8);
    }
}
