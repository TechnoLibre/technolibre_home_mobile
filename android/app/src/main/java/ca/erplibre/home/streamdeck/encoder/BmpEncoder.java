package ca.erplibre.home.streamdeck.encoder;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;

import ca.erplibre.home.streamdeck.encoder.ImageEncoder.ImageEncodeException;

/**
 * BMP encoder for v1 / Mini Stream Decks. Accepts PNG bytes from TS,
 * decodes to ARGB via Android's BitmapFactory, then delegates rotation,
 * flip and BGR conversion to RgbaRotator (pure Java, unit-tested).
 *
 * The deck firmware expects a fully-formed BMP file, 54-byte header
 * included. The output is byte for byte what python-elgato-streamdeck
 * sends for the same pixels: its KEY_ROTATION and KEY_FLIP, then a
 * Pillow BMP, whose rows are stored bottom-up.
 */
public final class BmpEncoder implements ImageEncoder {

    /** 180: Original v1, KEY_FLIP (True, True). 270: Mini, KEY_ROTATION 90
     *  (counterclockwise) then KEY_FLIP (False, True). */
    private final int rotationDegrees;

    public BmpEncoder(int rotationDegrees) {
        if (rotationDegrees != 180 && rotationDegrees != 270) {
            throw new IllegalArgumentException("BmpEncoder rotation must be 180 or 270");
        }
        this.rotationDegrees = rotationDegrees;
    }

    @Override public String inputFormat() { return "png"; }

    @Override
    public byte[] encode(byte[] inputBytes, int targetW, int targetH) throws ImageEncodeException {
        if (inputBytes == null || inputBytes.length < 8) {
            throw new ImageEncodeException("image_decode_failed:empty_or_truncated");
        }
        // PNG magic check
        if ((inputBytes[0] & 0xFF) != 0x89 || (inputBytes[1] & 0xFF) != 0x50
                || (inputBytes[2] & 0xFF) != 0x4E || (inputBytes[3] & 0xFF) != 0x47) {
            throw new ImageEncodeException("format_mismatch:bmp_model_requires_png");
        }

        Bitmap bmp = BitmapFactory.decodeByteArray(inputBytes, 0, inputBytes.length);
        if (bmp == null) throw new ImageEncodeException("image_decode_failed");

        if (bmp.getWidth() != targetW || bmp.getHeight() != targetH) {
            Bitmap scaled = Bitmap.createScaledBitmap(bmp, targetW, targetH, true);
            bmp.recycle();
            bmp = scaled;
        }

        int[] argb = new int[targetW * targetH];
        bmp.getPixels(argb, 0, targetW, 0, 0, targetW, targetH);
        bmp.recycle();
        return encodeArgb(argb, targetW, targetH);
    }

    /** encode() after the PNG decode: ARGB pixels, row-major, to the BMP file. */
    byte[] encodeArgb(int[] argb, int targetW, int targetH) {
        byte[] bgr = (rotationDegrees == 270)
            ? RgbaRotator.toBgr(argb, targetW, targetH, 270, false, true)
            : RgbaRotator.toBgr(argb, targetW, targetH, 0, true, true);
        int outW = (rotationDegrees == 270) ? targetH : targetW;
        int outH = (rotationDegrees == 270) ? targetW : targetH;
        return wrapAsBmpFile(bgr, outW, outH);
    }

    /** Black needs no rotation: only the BMP header carries the size. */
    @Override
    public byte[] blank(int targetW, int targetH) {
        int outW = (rotationDegrees == 270) ? targetH : targetW;
        int outH = (rotationDegrees == 270) ? targetW : targetH;
        return wrapAsBmpFile(new byte[outW * outH * 3], outW, outH);
    }

    /**
     * Wraps top-down BGR pixels in a 54-byte BITMAPINFOHEADER BMP file laid
     * out as Pillow writes it: positive height, rows stored bottom-up, 96 dpi.
     * Rows are NOT padded because BGR width is always a multiple of 4 for
     * the supported sizes (72, 80).
     */
    static byte[] wrapAsBmpFile(byte[] bgr, int w, int h) {
        final int header = 54;
        final int rowBytes = w * 3;
        if (rowBytes % 4 != 0) {
            throw new IllegalStateException("BMP row " + rowBytes + " not 4-aligned for w=" + w);
        }
        int fileSize = header + bgr.length;
        byte[] out = new byte[fileSize];

        // BITMAPFILEHEADER (14 bytes)
        out[0] = 'B'; out[1] = 'M';
        writeLE32(out, 2, fileSize);
        // 6-9 reserved = 0
        writeLE32(out, 10, header);              // pixel offset

        // BITMAPINFOHEADER (40 bytes)
        writeLE32(out, 14, 40);                  // header size
        writeLE32(out, 18, w);
        writeLE32(out, 22, h);                   // positive h = rows bottom-up
        writeLE16(out, 26, 1);                   // planes
        writeLE16(out, 28, 24);                  // bpp
        writeLE32(out, 30, 0);                   // compression = BI_RGB
        writeLE32(out, 34, bgr.length);          // image size
        writeLE32(out, 38, 3780);                // x ppm (96 dpi)
        writeLE32(out, 42, 3780);                // y ppm
        // 46-49 colors used = 0; 50-53 important colors = 0

        for (int row = 0; row < h; row++) {
            System.arraycopy(bgr, row * rowBytes, out, header + (h - 1 - row) * rowBytes, rowBytes);
        }
        return out;
    }

    private static void writeLE32(byte[] buf, int off, int v) {
        buf[off]     = (byte) (v & 0xFF);
        buf[off + 1] = (byte) ((v >> 8) & 0xFF);
        buf[off + 2] = (byte) ((v >> 16) & 0xFF);
        buf[off + 3] = (byte) ((v >> 24) & 0xFF);
    }
    private static void writeLE16(byte[] buf, int off, int v) {
        buf[off]     = (byte) (v & 0xFF);
        buf[off + 1] = (byte) ((v >> 8) & 0xFF);
    }
}
