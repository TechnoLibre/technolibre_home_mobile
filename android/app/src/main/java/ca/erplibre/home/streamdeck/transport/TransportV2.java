package ca.erplibre.home.streamdeck.transport;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Gen-2 pagination (Original v2, MK.2, XL, Plus, Neo).
 * Page = 1024 bytes total = 8-byte header + 1016-byte payload.
 *
 * Header:
 *   byte 0: 0x02 (HID report ID)
 *   byte 1: 0x07 (set image command)
 *   byte 2: key index
 *   byte 3: 0x01 if last page else 0x00
 *   byte 4-5: payload length (LE u16)
 *   byte 6-7: page number (LE u16, starts at 0)
 */
public final class TransportV2 implements DeckTransport {

    public  static final int PAGE_SIZE     = 1024;
    public  static final int HEADER_SIZE   = 8;
    public  static final int PAYLOAD_SIZE  = PAGE_SIZE - HEADER_SIZE; // 1016

    @Override public int pageSize() { return PAGE_SIZE; }

    @Override
    public List<byte[]> paginateKeyImage(int keyIndex, byte[] imageBytes) {
        return paginateKeyImageStatic(keyIndex, imageBytes);
    }

    public static List<byte[]> paginateKeyImageStatic(int keyIndex, byte[] imageBytes) {
        if (imageBytes.length == 0) return Collections.emptyList();

        int pageCount = (imageBytes.length + PAYLOAD_SIZE - 1) / PAYLOAD_SIZE;
        List<byte[]> pages = new ArrayList<>(pageCount);

        int offset = 0;
        for (int p = 0; p < pageCount; p++) {
            int remaining = imageBytes.length - offset;
            int payloadLen = Math.min(PAYLOAD_SIZE, remaining);
            boolean isLast = (p == pageCount - 1);

            byte[] page = new byte[PAGE_SIZE]; // zero-init, gives padding
            page[0] = 0x02;
            page[1] = 0x07;
            page[2] = (byte) keyIndex;
            page[3] = (byte) (isLast ? 0x01 : 0x00);
            page[4] = (byte) (payloadLen & 0xFF);
            page[5] = (byte) ((payloadLen >> 8) & 0xFF);
            page[6] = (byte) (p & 0xFF);
            page[7] = (byte) ((p >> 8) & 0xFF);

            System.arraycopy(imageBytes, offset, page, HEADER_SIZE, payloadLen);
            pages.add(page);
            offset += payloadLen;
        }
        return pages;
    }
}
