package ca.erplibre.home.streamdeck.lcd;

import java.util.ArrayList;
import java.util.List;

/**
 * Pagination for the Plus touchscreen LCD (800x100 JPEG) and the Neo
 * info screen (248x58 JPEG). The two devices use different command bytes
 * and header layouts, so each has its own static method.
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
 * Neo screen wire format (cross-checked against python-elgato-streamdeck StreamDeckNeo.py):
 *   page = 1024 bytes total = 8-byte header + 1016-byte payload
 *   byte 0:   0x02
 *   byte 1:   0x0B   (set screen image command)
 *   byte 2:   0x00
 *   byte 3:   isLast (0x01 final, 0x00 otherwise)
 *   byte 4-5: payload length (LE u16)
 *   byte 6-7: page number    (LE u16)
 */
public final class LcdEncoder {

    // Plus LCD constants
    public static final int PAGE_SIZE    = 1024;
    public static final int HEADER_SIZE  = 16;
    public static final int PAYLOAD_SIZE = PAGE_SIZE - HEADER_SIZE; // 1008

    public static final int PLUS_LCD_W = 800;
    public static final int PLUS_LCD_H = 100;

    // Neo screen constants
    public static final int NEO_HEADER_SIZE  = 8;
    public static final int NEO_PAYLOAD_SIZE = PAGE_SIZE - NEO_HEADER_SIZE; // 1016

    public static final int NEO_SCREEN_W = 248;
    public static final int NEO_SCREEN_H = 58;

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

    /**
     * Pagination for the Neo info screen. JPEG bytes are split into 1024-byte
     * pages with an 8-byte header carrying command 0x0B, isLast flag,
     * payload length, and page number.
     */
    public static List<byte[]> paginateNeoScreen(byte[] jpegBytes) {
        if (jpegBytes == null || jpegBytes.length == 0) {
            throw new IllegalArgumentException("empty jpeg bytes");
        }

        int pageCount = (jpegBytes.length + NEO_PAYLOAD_SIZE - 1) / NEO_PAYLOAD_SIZE;
        List<byte[]> pages = new ArrayList<>(pageCount);

        int offset = 0;
        for (int p = 0; p < pageCount; p++) {
            int remaining = jpegBytes.length - offset;
            int payloadLen = Math.min(NEO_PAYLOAD_SIZE, remaining);
            boolean isLast = (p == pageCount - 1);

            byte[] page = new byte[PAGE_SIZE];
            page[0] = 0x02;
            page[1] = 0x0B;
            page[2] = 0x00;
            page[3] = (byte) (isLast ? 0x01 : 0x00);
            writeLE16(page, 4, payloadLen);
            writeLE16(page, 6, p);

            System.arraycopy(jpegBytes, offset, page, NEO_HEADER_SIZE, payloadLen);
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
