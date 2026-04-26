package ca.erplibre.home.streamdeck.lcd;

import static org.junit.Assert.*;
import org.junit.Test;
import java.util.List;

public class LcdEncoderTest {

    @Test
    public void plus_full_lcd_paginates_with_correct_command_byte() {
        byte[] jpeg = new byte[5000];
        jpeg[0] = (byte) 0xFF; jpeg[1] = (byte) 0xD8; jpeg[2] = (byte) 0xFF;
        List<byte[]> pages = LcdEncoder.paginatePlusLcd(0, 0, 800, 100, jpeg);
        assertFalse(pages.isEmpty());
        for (byte[] p : pages) {
            assertEquals(1024, p.length);
            assertEquals(0x02, p[0] & 0xFF);
            assertEquals(0x0C, p[1] & 0xFF);
        }
        byte[] p0 = pages.get(0);
        assertEquals(0,   (p0[2] & 0xFF) | ((p0[3] & 0xFF) << 8));
        assertEquals(0,   (p0[4] & 0xFF) | ((p0[5] & 0xFF) << 8));
        assertEquals(800, (p0[6] & 0xFF) | ((p0[7] & 0xFF) << 8));
        assertEquals(100, (p0[8] & 0xFF) | ((p0[9] & 0xFF) << 8));
        // Actual wire format (cross-checked vs python-elgato-streamdeck StreamDeckPlus.py):
        // byte 10: isLast flag
        // byte 11-12: page number (LE u16)
        // byte 13-14: payload length (LE u16)
        // byte 15: padding (0x00)
        byte[] last = pages.get(pages.size() - 1);
        assertEquals(0x01, last[10] & 0xFF);
    }

    @Test(expected = IllegalArgumentException.class)
    public void plus_lcd_rejects_oversized_region() {
        LcdEncoder.paginatePlusLcd(0, 0, 801, 100, new byte[1]);
    }
}
