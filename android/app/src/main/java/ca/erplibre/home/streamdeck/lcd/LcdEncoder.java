package ca.erplibre.home.streamdeck.lcd;

import java.util.ArrayList;
import java.util.List;

/**
 * Pagination for the Plus touchscreen LCD (800x100 JPEG).
 *
 * Plus LCD wire format (cross-checked against python-elgato-streamdeck StreamDeckPlus.py):
 *   page = 1024 bytes total = 16-byte header + 1008-byte payload
 *   byte 0:     0x02
 *   byte 1:     0x0C   (touchscreen image set)
 *   byte 2-3:   x             (LE u16)
 *   byte 4-5:   y             (LE u16)
 *   byte 6-7:   w             (LE u16)
 *   byte 8-9:   h             (LE u16)
 *   byte 10:    isLast        (0x01 final, 0x00 otherwise)
 *   byte 11-12: page number   (LE u16)
 *   byte 13-14: payload length (LE u16)
 *   byte 15:    padding       (0x00)
 *
 * NOTE: The plan-documented layout placed reserved at byte 11, page at 12-13,
 * and payload length at 14-15. The actual Python reference source uses the
 * layout above (page at 11-12, payload at 13-14, padding at 15).
 */
public final class LcdEncoder {

    public static final int PAGE_SIZE    = 1024;
    public static final int HEADER_SIZE  = 16;
    public static final int PAYLOAD_SIZE = PAGE_SIZE - HEADER_SIZE; // 1008

    public static final int PLUS_LCD_W = 800;
    public static final int PLUS_LCD_H = 100;

    private LcdEncoder() {}

    public static List<byte[]> paginatePlusLcd(int x, int y, int w, int h, byte[] jpegBytes) {
        if (x < 0 || y < 0 || w <= 0 || h <= 0
                || x + w > PLUS_LCD_W || y + h > PLUS_LCD_H) {
            throw new IllegalArgumentException(
                "lcd region (" + x + "," + y + "," + w + "," + h + ") out of bounds");
        }
        if (jpegBytes == null || jpegBytes.length == 0) {
            throw new IllegalArgumentException("empty jpeg bytes");
        }

        int pageCount = (jpegBytes.length + PAYLOAD_SIZE - 1) / PAYLOAD_SIZE;
        List<byte[]> pages = new ArrayList<>(pageCount);

        int offset = 0;
        for (int p = 0; p < pageCount; p++) {
            int remaining = jpegBytes.length - offset;
            int payloadLen = Math.min(PAYLOAD_SIZE, remaining);
            boolean isLast = (p == pageCount - 1);

            byte[] page = new byte[PAGE_SIZE];
            page[0] = 0x02;
            page[1] = 0x0C;
            writeLE16(page, 2, x);
            writeLE16(page, 4, y);
            writeLE16(page, 6, w);
            writeLE16(page, 8, h);
            page[10] = (byte) (isLast ? 0x01 : 0x00);
            writeLE16(page, 11, p);
            writeLE16(page, 13, payloadLen);
            page[15] = 0x00; // padding

            System.arraycopy(jpegBytes, offset, page, HEADER_SIZE, payloadLen);
            pages.add(page);
            offset += payloadLen;
        }
        return pages;
    }

    private static void writeLE16(byte[] buf, int off, int v) {
        buf[off]     = (byte) (v & 0xFF);
        buf[off + 1] = (byte) ((v >> 8) & 0xFF);
    }
}
