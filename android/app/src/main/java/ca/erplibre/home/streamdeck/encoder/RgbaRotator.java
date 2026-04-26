package ca.erplibre.home.streamdeck.encoder;

/**
 * Pure-Java helper that converts an ARGB int[] (Android Bitmap pixel layout)
 * to a BGR byte[] with optional rotation. Used by BmpEncoder for v1 / Mini.
 *
 * Supported rotations: 0, 180, 270 (counterclockwise).
 *
 * Output layout: row-major BGR triplets, scanned left-to-right top-to-bottom
 * in the destination orientation.
 */
public final class RgbaRotator {

    private RgbaRotator() {}

    public static byte[] toBgrRotated(int[] argb, int w, int h, int rotation) {
        if (rotation != 0 && rotation != 180 && rotation != 270) {
            throw new IllegalArgumentException("rotation must be 0, 180, or 270 (got " + rotation + ")");
        }
        if (argb.length != w * h) {
            throw new IllegalArgumentException("argb length " + argb.length + " != " + w + "*" + h);
        }

        int outW, outH;
        if (rotation == 270) { outW = h; outH = w; }
        else                 { outW = w; outH = h; }

        byte[] out = new byte[outW * outH * 3];

        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int pixel = argb[y * w + x];
                int b = pixel & 0xFF;
                int g = (pixel >> 8) & 0xFF;
                int r = (pixel >> 16) & 0xFF;

                int dstX, dstY;
                switch (rotation) {
                    case 180: dstX = w - 1 - x; dstY = h - 1 - y; break;
                    case 270: dstX = y;         dstY = w - 1 - x; break;
                    default:  dstX = x;         dstY = y;         break;
                }
                int dstOff = (dstY * outW + dstX) * 3;
                out[dstOff]     = (byte) b;
                out[dstOff + 1] = (byte) g;
                out[dstOff + 2] = (byte) r;
            }
        }
        return out;
    }
}
