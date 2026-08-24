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

    @Test
    public void neo_screen_single_page_when_smaller_than_payload() {
        byte[] jpeg = new byte[100];
        for (int i = 0; i < jpeg.length; i++) jpeg[i] = (byte) (i & 0xFF);

        List<byte[]> pages = LcdEncoder.paginateNeoScreen(jpeg);
        assertEquals(1, pages.size());

        byte[] p = pages.get(0);
        assertEquals(1024, p.length);
        assertEquals(0x02, p[0] & 0xFF);            // report id
        assertEquals(0x0B, p[1] & 0xFF);            // Neo screen command
        assertEquals(0x00, p[2] & 0xFF);            // reserved
        assertEquals(0x01, p[3] & 0xFF);            // last flag
        assertEquals(100,  (p[4] & 0xFF) | ((p[5] & 0xFF) << 8));   // payload length
        assertEquals(0,    (p[6] & 0xFF) | ((p[7] & 0xFF) << 8));   // page 0
        // Payload starts at byte 8.
        assertEquals(0,  p[8] & 0xFF);
        assertEquals(99, p[8 + 99] & 0xFF);
    }

    @Test
    public void neo_screen_multi_page_splits_correctly() {
        // 3000 bytes -> ceil(3000 / 1016) = 3 pages.
        byte[] jpeg = new byte[3000];
        List<byte[]> pages = LcdEncoder.paginateNeoScreen(jpeg);
        assertEquals(3, pages.size());

        // Pages 0/1 not last, page 2 last.
        assertEquals(0x00, pages.get(0)[3] & 0xFF);
        assertEquals(0x00, pages.get(1)[3] & 0xFF);
        assertEquals(0x01, pages.get(2)[3] & 0xFF);

        // Page numbers 0, 1, 2.
        assertEquals(0, (pages.get(0)[6] & 0xFF) | ((pages.get(0)[7] & 0xFF) << 8));
        assertEquals(1, (pages.get(1)[6] & 0xFF) | ((pages.get(1)[7] & 0xFF) << 8));
        assertEquals(2, (pages.get(2)[6] & 0xFF) | ((pages.get(2)[7] & 0xFF) << 8));

        // Payload lengths: 1016, 1016, 968 (3000 - 2*1016).
        assertEquals(1016, (pages.get(0)[4] & 0xFF) | ((pages.get(0)[5] & 0xFF) << 8));
        assertEquals(1016, (pages.get(1)[4] & 0xFF) | ((pages.get(1)[5] & 0xFF) << 8));
        assertEquals(968,  (pages.get(2)[4] & 0xFF) | ((pages.get(2)[5] & 0xFF) << 8));
    }

    @Test(expected = IllegalArgumentException.class)
    public void neo_screen_rejects_empty_payload() {
        LcdEncoder.paginateNeoScreen(new byte[0]);
    }
}
