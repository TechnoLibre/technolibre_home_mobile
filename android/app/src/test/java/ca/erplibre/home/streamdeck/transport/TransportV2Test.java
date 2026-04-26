package ca.erplibre.home.streamdeck.transport;

import static org.junit.Assert.*;
import org.junit.Test;
import java.util.List;

public class TransportV2Test {

    @Test
    public void single_page_image_when_smaller_than_payload() {
        byte[] img = new byte[100];
        for (int i = 0; i < img.length; i++) img[i] = (byte) (i & 0xFF);

        List<byte[]> pages = TransportV2.paginateKeyImageStatic(3, img);
        assertEquals(1, pages.size());

        byte[] p0 = pages.get(0);
        assertEquals(1024, p0.length);
        assertEquals(0x02, p0[0] & 0xFF);
        assertEquals(0x07, p0[1] & 0xFF);
        assertEquals(3,    p0[2] & 0xFF);
        assertEquals(0x01, p0[3] & 0xFF);
        assertEquals(100,  (p0[4] & 0xFF) | ((p0[5] & 0xFF) << 8));
        assertEquals(0,    (p0[6] & 0xFF) | ((p0[7] & 0xFF) << 8));
        assertEquals(0, p0[8] & 0xFF);
        assertEquals(99, p0[8 + 99] & 0xFF);
    }

    @Test
    public void multi_page_image_splits_correctly() {
        byte[] img = new byte[3000];
        for (int i = 0; i < img.length; i++) img[i] = (byte) (i & 0xFF);

        List<byte[]> pages = TransportV2.paginateKeyImageStatic(0, img);
        assertEquals(3, pages.size());

        assertEquals(0x00, pages.get(0)[3] & 0xFF);
        assertEquals(1016, (pages.get(0)[4] & 0xFF) | ((pages.get(0)[5] & 0xFF) << 8));
        assertEquals(0,    (pages.get(0)[6] & 0xFF) | ((pages.get(0)[7] & 0xFF) << 8));

        assertEquals(0x00, pages.get(1)[3] & 0xFF);
        assertEquals(1016, (pages.get(1)[4] & 0xFF) | ((pages.get(1)[5] & 0xFF) << 8));
        assertEquals(1,    (pages.get(1)[6] & 0xFF) | ((pages.get(1)[7] & 0xFF) << 8));

        assertEquals(0x01, pages.get(2)[3] & 0xFF);
        assertEquals(968,  (pages.get(2)[4] & 0xFF) | ((pages.get(2)[5] & 0xFF) << 8));
        assertEquals(2,    (pages.get(2)[6] & 0xFF) | ((pages.get(2)[7] & 0xFF) << 8));
    }

    @Test
    public void exact_multiple_payload_creates_full_pages_with_last_flag_on_final() {
        byte[] img = new byte[2032];
        List<byte[]> pages = TransportV2.paginateKeyImageStatic(0, img);
        assertEquals(2, pages.size());
        assertEquals(0x00, pages.get(0)[3] & 0xFF);
        assertEquals(0x01, pages.get(1)[3] & 0xFF);
        assertEquals(1016, (pages.get(1)[4] & 0xFF) | ((pages.get(1)[5] & 0xFF) << 8));
    }

    @Test
    public void last_page_payload_zero_padded() {
        byte[] img = new byte[10];
        for (int i = 0; i < img.length; i++) img[i] = (byte) 0xAA;
        List<byte[]> pages = TransportV2.paginateKeyImageStatic(0, img);
        byte[] p = pages.get(0);
        for (int i = 18; i < 1024; i++) {
            assertEquals("padding at " + i, 0, p[i]);
        }
    }
}
