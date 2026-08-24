package ca.erplibre.home.streamdeck.transport;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Gen-1 pagination (Original v1, Mini).
 * Page = 8191 bytes total = 16-byte header + 8175-byte payload.
 *
 * Header (cross-checked against python-elgato-streamdeck StreamDeckOriginal.py):
 *   byte 0: 0x02
 *   byte 1: 0x01 (set image)
 *   byte 2: page number (1-indexed, i.e. first page = 1)
 *   byte 3: 0x00 (reserved — NOT the high byte of a LE u16)
 *   byte 4: 0x01 if last page else 0x00
 *   byte 5: key index (1-indexed, i.e. key 0 -> 1)
 *   byte 6-15: reserved (zero)
 *
 * Deviations from original plan-time bytes:
 *   - Plan said byte 2-3 = page as LE u16 (0-indexed). Python source uses
 *     byte 2 = page+1 (1-indexed), byte 3 = 0x00 (reserved).
 *   - Plan said byte 5 = key index (0-indexed). Python source uses key+1 (1-indexed).
 */
public final class TransportV1 implements DeckTransport {

    public  static final int PAGE_SIZE    = 8191;
    public  static final int HEADER_SIZE  = 16;
    public  static final int PAYLOAD_SIZE = PAGE_SIZE - HEADER_SIZE; // 8175

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

            byte[] page = new byte[PAGE_SIZE]; // zero-init provides padding
            page[0] = 0x02;
            page[1] = 0x01;
            // Page number is 1-indexed on the wire (python source: page_number + 1)
            page[2] = (byte) ((p + 1) & 0xFF);
            page[3] = 0x00; // reserved
            page[4] = (byte) (isLast ? 0x01 : 0x00);
            // Key index is 1-indexed on the wire (python source: key + 1)
            page[5] = (byte) ((keyIndex + 1) & 0xFF);
            // bytes 6..15 left as 0 (reserved)

            System.arraycopy(imageBytes, offset, page, HEADER_SIZE, payloadLen);
            pages.add(page);
            offset += payloadLen;
        }
        return pages;
    }
}
