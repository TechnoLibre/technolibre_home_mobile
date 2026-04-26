package ca.erplibre.home.streamdeck.transport;

import static org.junit.Assert.*;
import org.junit.Test;
import java.util.List;

/**
 * Cross-checked against python-elgato-streamdeck StreamDeckOriginal.py.
 *
 * Deviations from plan-time bytes:
 *   - byte 2: page number is 1-indexed (page + 1), NOT 0-indexed
 *   - byte 3: reserved 0x00, NOT the high byte of a LE u16 page number
 *   - byte 5: key index is 1-indexed (key + 1), NOT 0-indexed
 */
public class TransportV1Test {

    @Test
    public void single_page_smaller_than_payload() {
        byte[] img = new byte[100];
        for (int i = 0; i < img.length; i++) img[i] = (byte) (i & 0xFF);

        List<byte[]> pages = TransportV1.paginateKeyImageStatic(2, img);
        assertEquals(1, pages.size());

        byte[] p = pages.get(0);
        assertEquals(TransportV1.PAGE_SIZE, p.length);
        assertEquals(0x02, p[0] & 0xFF);
        assertEquals(0x01, p[1] & 0xFF);
        // page 0 -> transmitted as 1 (1-indexed), byte 3 reserved = 0x00
        assertEquals(1,    p[2] & 0xFF);
        assertEquals(0x00, p[3] & 0xFF);
        assertEquals(0x01, p[4] & 0xFF);                              // last
        // key 2 -> transmitted as 3 (1-indexed)
        assertEquals(3,    p[5] & 0xFF);
        assertEquals(99, p[16 + 99] & 0xFF); // payload starts at byte 16
    }

    @Test
    public void multi_page_splits_correctly() {
        byte[] img = new byte[20000];
        List<byte[]> pages = TransportV1.paginateKeyImageStatic(0, img);
        // 8191 - 16 = 8175 payload per page. 20000 / 8175 = 3 pages.
        assertEquals(3, pages.size());
        // Pages are 1-indexed in the wire format
        assertEquals(1, pages.get(0)[2] & 0xFF);
        assertEquals(2, pages.get(1)[2] & 0xFF);
        assertEquals(3, pages.get(2)[2] & 0xFF);
        // byte 3 is reserved (0x00) in all pages
        assertEquals(0x00, pages.get(0)[3] & 0xFF);
        assertEquals(0x00, pages.get(1)[3] & 0xFF);
        assertEquals(0x00, pages.get(2)[3] & 0xFF);
        // Only last page has last-flag set.
        assertEquals(0x00, pages.get(0)[4] & 0xFF);
        assertEquals(0x00, pages.get(1)[4] & 0xFF);
        assertEquals(0x01, pages.get(2)[4] & 0xFF);
    }

    @Test
    public void empty_image_yields_no_pages() {
        assertTrue(TransportV1.paginateKeyImageStatic(0, new byte[0]).isEmpty());
    }
}
