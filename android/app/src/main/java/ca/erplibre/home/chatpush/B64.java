package ca.erplibre.home.chatpush;

/**
 * Base64 codec free of android.util and java.util.Base64 (API 26, above the
 * minSdk 24), so the same code runs on the device and on the JVM.
 */
final class B64 {

    private static final char[] STD =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();
    private static final char[] URL =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".toCharArray();

    private B64() {}

    /** Encodes with the standard alphabet and '=' padding, or the URL-safe one without. */
    static String encode(byte[] in, boolean urlSafe) {
        char[] alphabet = urlSafe ? URL : STD;
        StringBuilder out = new StringBuilder((in.length + 2) / 3 * 4);
        for (int i = 0; i < in.length; i += 3) {
            int b0 = in[i] & 0xff;
            int b1 = i + 1 < in.length ? in[i + 1] & 0xff : 0;
            int b2 = i + 2 < in.length ? in[i + 2] & 0xff : 0;
            out.append(alphabet[b0 >> 2]);
            out.append(alphabet[((b0 & 3) << 4) | (b1 >> 4)]);
            if (i + 1 < in.length) out.append(alphabet[((b1 & 15) << 2) | (b2 >> 6)]);
            else if (!urlSafe) out.append('=');
            if (i + 2 < in.length) out.append(alphabet[b2 & 63]);
            else if (!urlSafe) out.append('=');
        }
        return out.toString();
    }

    /**
     * Decodes either alphabet, with or without padding. Throws
     * IllegalArgumentException on a character outside both alphabets or an
     * impossible length; the message never echoes the input.
     */
    static byte[] decode(String s) {
        int n = s.length();
        while (n > 0 && s.charAt(n - 1) == '=') n--;
        if (n % 4 == 1) throw new IllegalArgumentException("bad base64 length");
        byte[] out = new byte[n * 3 / 4];
        int acc = 0;
        int bits = 0;
        int o = 0;
        for (int i = 0; i < n; i++) {
            int v = value(s.charAt(i));
            acc = (acc << 6) | v;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out[o++] = (byte) (acc >> bits);
                acc &= (1 << bits) - 1;
            }
        }
        return out;
    }

    private static int value(char c) {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '+' || c == '-') return 62;
        if (c == '/' || c == '_') return 63;
        throw new IllegalArgumentException("bad base64 character");
    }
}
