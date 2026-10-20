package ca.erplibre.home.streamdeck;

import ca.erplibre.home.streamdeck.encoder.BmpEncoder;
import ca.erplibre.home.streamdeck.encoder.ImageEncoder;
import ca.erplibre.home.streamdeck.encoder.ImageHeader;
import ca.erplibre.home.streamdeck.encoder.JpegEncoder;

/**
 * Key image rules every model shares, free of Android types so JUnit covers
 * them: which encoder a model uses, which key indexes exist, and which
 * images fit a key. Each check returns the plugin's rejection code, or null
 * when the argument is acceptable.
 */
final class KeyImages {

    private KeyImages() {}

    static ImageEncoder encoderFor(DeckSpec spec) {
        switch (spec.keyImageFormat) {
            case JPEG:            return new JpegEncoder();
            case BMP_BGR_ROT180:  return new BmpEncoder(180);
            case BMP_BGR_ROT270:  return new BmpEncoder(270);
            default: throw new IllegalStateException("unknown format " + spec.keyImageFormat);
        }
    }

    /** "missing:key", "invalid_key:N" outside 0..keyCount-1, or null. */
    static String checkKey(Integer key, DeckSpec spec) {
        if (key == null) return "missing:key";
        if (key < 0 || key >= spec.keyCount) return "invalid_key:" + key;
        return null;
    }

    /**
     * "image_oversized:WxH>KWxKH" when the image's header declares more
     * pixels than the key has on either side, or null. A JPEG goes to the
     * deck as is, unscaled; a PNG would be decoded whole before being
     * scaled down. An image whose header cannot be read passes: the
     * encoder rejects it with its own code.
     */
    static String checkSize(byte[] image, DeckSpec spec) {
        int[] wh = ImageHeader.dimensions(image);
        if (wh == null) return null;
        if (wh[0] <= spec.keyImageW && wh[1] <= spec.keyImageH) return null;
        return "image_oversized:" + wh[0] + "x" + wh[1] + ">" + spec.keyImageW + "x" + spec.keyImageH;
    }
}
