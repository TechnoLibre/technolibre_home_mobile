package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

import ca.erplibre.home.streamdeck.encoder.ImageEncoder;
import ca.erplibre.home.streamdeck.encoder.ImageHeader;
import ca.erplibre.home.streamdeck.encoder.ImageHeaderTest;

public class KeyImagesTest {

    /** Every product id DeckRegistry knows. */
    private static final int[] ALL_PIDS = {
        0x0060, 0x0063, 0x006c, 0x008f, 0x006d, 0x0080, 0x0084, 0x009a,
    };

    private static DeckSpec mk2()  { return DeckRegistry.lookup(0x0080); }
    private static DeckSpec mini() { return DeckRegistry.lookup(0x0063); }

    // ── key index ──────────────────────────────────────────────────────

    @Test
    public void missing_key_is_rejected() {
        assertEquals("missing:key", KeyImages.checkKey(null, mk2()));
    }

    @Test
    public void key_out_of_range_is_rejected() {
        assertEquals("invalid_key:-1", KeyImages.checkKey(-1, mk2()));
        assertEquals("invalid_key:15", KeyImages.checkKey(15, mk2()));
        assertEquals("invalid_key:6", KeyImages.checkKey(6, mini()));
    }

    @Test
    public void every_key_of_every_model_is_accepted() {
        for (int pid : ALL_PIDS) {
            DeckSpec s = DeckRegistry.lookup(pid);
            for (int k = 0; k < s.keyCount; k++) assertNull(s.model + " key " + k, KeyImages.checkKey(k, s));
        }
    }

    // ── image size ─────────────────────────────────────────────────────

    @Test
    public void jpeg_larger_than_the_key_is_oversized() {
        byte[] jpeg = ImageHeaderTest.jpeg(96, 96);
        assertEquals("image_oversized:96x96>72x72", KeyImages.checkSize(jpeg, mk2()));
    }

    @Test
    public void jpeg_wider_only_is_oversized() {
        assertEquals("image_oversized:73x72>72x72",
            KeyImages.checkSize(ImageHeaderTest.jpeg(73, 72), mk2()));
    }

    @Test
    public void jpeg_at_or_below_key_size_fits() {
        assertNull(KeyImages.checkSize(ImageHeaderTest.jpeg(72, 72), mk2()));
        assertNull(KeyImages.checkSize(ImageHeaderTest.jpeg(1, 1), mk2()));
    }

    @Test
    public void png_larger_than_the_key_is_oversized() {
        assertEquals("image_oversized:160x160>80x80",
            KeyImages.checkSize(ImageHeaderTest.png(160, 160), mini()));
        assertNull(KeyImages.checkSize(ImageHeaderTest.png(80, 80), mini()));
    }

    @Test
    public void unreadable_header_is_left_to_the_encoder() {
        // The encoder rejects it with its own format or decode error.
        assertNull(KeyImages.checkSize(new byte[] { 1, 2, 3 }, mk2()));
        assertNull(KeyImages.checkSize(new byte[0], mk2()));
    }

    // ── blank key ──────────────────────────────────────────────────────

    @Test
    public void every_model_has_a_blank_at_its_native_size_and_format() throws Exception {
        for (int pid : ALL_PIDS) {
            DeckSpec s = DeckRegistry.lookup(pid);
            ImageEncoder enc = KeyImages.encoderFor(s);
            byte[] blank = enc.blank(s.keyImageW, s.keyImageH);
            if (s.keyImageFormat == DeckSpec.ImageFormat.JPEG) {
                int[] wh = ImageHeader.dimensions(blank);
                assertNotNull(s.model, wh);
                assertEquals(s.model + " w", s.keyImageW, wh[0]);
                assertEquals(s.model + " h", s.keyImageH, wh[1]);
                assertEquals(s.model, 0xD9, blank[blank.length - 1] & 0xFF);
            } else {
                assertEquals(s.model, 'B', blank[0]);
                assertEquals(s.model, 'M', blank[1]);
                assertEquals(s.model + " w", s.keyImageW, le32(blank, 18));
                assertEquals(s.model + " h", s.keyImageH, Math.abs(le32(blank, 22)));
                assertEquals(s.model + " length", 54 + s.keyImageW * s.keyImageH * 3, blank.length);
                for (int i = 54; i < blank.length; i++) assertEquals(s.model + " black", 0, blank[i]);
            }
        }
    }

    @Test
    public void blank_fits_the_size_check_of_its_own_model() throws Exception {
        for (int pid : ALL_PIDS) {
            DeckSpec s = DeckRegistry.lookup(pid);
            byte[] blank = KeyImages.encoderFor(s).blank(s.keyImageW, s.keyImageH);
            assertNull(s.model, KeyImages.checkSize(blank, s));
        }
    }

    @Test(expected = ImageEncoder.ImageEncodeException.class)
    public void jpeg_blank_of_an_unknown_size_is_refused() throws Exception {
        KeyImages.encoderFor(mk2()).blank(50, 50);
    }

    private static int le32(byte[] b, int off) {
        return (b[off] & 0xFF) | ((b[off + 1] & 0xFF) << 8)
            | ((b[off + 2] & 0xFF) << 16) | ((b[off + 3] & 0xFF) << 24);
    }
}
