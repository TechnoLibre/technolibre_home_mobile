package ca.erplibre.home.streamdeck.encoder;

import static org.junit.Assert.*;
import org.junit.Test;

public class RgbaRotatorTest {

    /** Single red pixel ARGB 0xFFFF0000 → BGR bytes {0x00, 0x00, 0xFF}. */
    @Test
    public void single_pixel_argb_to_bgr() {
        int[] argb = {0xFFFF0000}; // red
        byte[] bgr = RgbaRotator.toBgrRotated(argb, 1, 1, 0);
        assertArrayEquals(new byte[]{0x00, 0x00, (byte) 0xFF}, bgr);
    }

    /**
     * 2×2 ARGB, no rotation:
     *   R G        BGR rows (top→bottom, left→right):
     *   B W        00 00 FF | 00 FF 00 | FF 00 00 | FF FF FF
     */
    @Test
    public void two_by_two_no_rotation() {
        int[] argb = {
            0xFFFF0000, 0xFF00FF00,
            0xFF0000FF, 0xFFFFFFFF
        };
        byte[] expected = {
            0x00, 0x00, (byte) 0xFF,   // R
            0x00, (byte) 0xFF, 0x00,   // G
            (byte) 0xFF, 0x00, 0x00,   // B
            (byte) 0xFF, (byte) 0xFF, (byte) 0xFF // W
        };
        assertArrayEquals(expected, RgbaRotator.toBgrRotated(argb, 2, 2, 0));
    }

    /**
     * 2×2 ARGB rotated 180° = pixel order reversed.
     *   R G  →  W B
     *   B W      G R
     */
    @Test
    public void two_by_two_rotated_180() {
        int[] argb = {
            0xFFFF0000, 0xFF00FF00,
            0xFF0000FF, 0xFFFFFFFF
        };
        byte[] out = RgbaRotator.toBgrRotated(argb, 2, 2, 180);
        // First output pixel = last input pixel (white)
        assertEquals((byte) 0xFF, out[0]);
        assertEquals((byte) 0xFF, out[1]);
        assertEquals((byte) 0xFF, out[2]);
        // Last output pixel = first input pixel (red)
        assertEquals(0x00, out[9]);
        assertEquals(0x00, out[10]);
        assertEquals((byte) 0xFF, out[11]);
    }

    /**
     * 2×3 ARGB rotated 270° (counterclockwise once = 90° clockwise three times):
     * input  (W=2, H=3):
     *   1 2
     *   3 4
     *   5 6
     * output (W=3, H=2) — 270° CCW takes (x, y) → (y, W-1-x):
     *   2 4 6
     *   1 3 5
     */
    @Test
    public void two_by_three_rotated_270() {
        int[] argb = {
            0x01010101, 0x02020202,
            0x03030303, 0x04040404,
            0x05050505, 0x06060606
        };
        byte[] out = RgbaRotator.toBgrRotated(argb, 2, 3, 270);
        // Output dim = 3 wide × 2 tall. Pixel 0 = input pixel 1 (val 0x02).
        assertEquals(0x02, out[0]);
        // Pixel 1 = input pixel 3 (val 0x04).
        assertEquals(0x04, out[3]);
        // Pixel 5 (last) = input pixel 4 (val 0x05).
        assertEquals(0x05, out[15]);
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejects_unsupported_rotation() {
        RgbaRotator.toBgrRotated(new int[]{0}, 1, 1, 45);
    }
}
