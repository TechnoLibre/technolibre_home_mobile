package ca.erplibre.home.streamdeck.encoder;

/**
 * Reads the pixel size an image declares in its header, without decoding
 * it: PNG from IHDR, JPEG from its frame header (SOFn). Pure Java, so it
 * runs before an image is queued and under JUnit.
 */
public final class ImageHeader {

    private ImageHeader() {}

    /** {width, height}, or null when the bytes are neither a PNG nor a JPEG
     *  whose frame header is reached before the scan data. */
    public static int[] dimensions(byte[] b) {
        if (b == null) return null;
        if (isPng(b)) {
            if (b.length < 24 || b[12] != 'I' || b[13] != 'H' || b[14] != 'D' || b[15] != 'R') return null;
            return new int[] { be32(b, 16), be32(b, 20) };
        }
        if (b.length >= 2 && (b[0] & 0xFF) == 0xFF && (b[1] & 0xFF) == 0xD8) return jpeg(b);
        return null;
    }

    private static boolean isPng(byte[] b) {
        return b.length >= 8 && (b[0] & 0xFF) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G';
    }

    /** Walks the segments after SOI. Each is FF, marker, then a 16-bit
     *  length counting itself; RSTn and TEM carry no length. A frame header
     *  is FF Cn with n not 4 (DHT), 8 (JPG) or C (DAC): precision, height,
     *  width follow the length. */
    private static int[] jpeg(byte[] b) {
        int i = 2;
        while (i + 3 < b.length) {
            if ((b[i] & 0xFF) != 0xFF) return null;
            int m = b[i + 1] & 0xFF;
            if (m == 0xFF) { i++; continue; }                       // fill byte
            if (m == 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
            if (m == 0xD9 || m == 0xDA) return null;                // EOI / SOS first
            int len = be16(b, i + 2);
            if (len < 2) return null;
            if (m >= 0xC0 && m <= 0xCF && m != 0xC4 && m != 0xC8 && m != 0xCC) {
                if (i + 8 >= b.length) return null;
                return new int[] { be16(b, i + 7), be16(b, i + 5) };
            }
            i += 2 + len;
        }
        return null;
    }

    private static int be16(byte[] b, int off) {
        return ((b[off] & 0xFF) << 8) | (b[off + 1] & 0xFF);
    }

    private static int be32(byte[] b, int off) {
        return ((b[off] & 0xFF) << 24) | ((b[off + 1] & 0xFF) << 16)
            | ((b[off + 2] & 0xFF) << 8) | (b[off + 3] & 0xFF);
    }
}
