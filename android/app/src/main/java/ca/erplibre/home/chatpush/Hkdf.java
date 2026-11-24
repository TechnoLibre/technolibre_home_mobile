package ca.erplibre.home.chatpush;

import java.security.GeneralSecurityException;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** HKDF (RFC 5869) over HMAC-SHA256. */
final class Hkdf {

    private static final String HMAC = "HmacSHA256";
    private static final int HASH_LEN = 32;

    private Hkdf() {}

    /** PRK = HMAC(salt, ikm); an empty salt stands for HashLen zero bytes. */
    static byte[] extract(byte[] salt, byte[] ikm) {
        byte[] key = salt.length == 0 ? new byte[HASH_LEN] : salt;
        return hmac(key, ikm);
    }

    /** The first length bytes of T(1) | T(2) | ...; length is at most 255 * 32. */
    static byte[] expand(byte[] prk, byte[] info, int length) {
        if (length < 0 || length > 255 * HASH_LEN) {
            throw new IllegalArgumentException("bad HKDF length");
        }
        byte[] out = new byte[length];
        byte[] t = new byte[0];
        int done = 0;
        for (int counter = 1; done < length; counter++) {
            byte[] msg = new byte[t.length + info.length + 1];
            System.arraycopy(t, 0, msg, 0, t.length);
            System.arraycopy(info, 0, msg, t.length, info.length);
            msg[msg.length - 1] = (byte) counter;
            t = hmac(prk, msg);
            int n = Math.min(t.length, length - done);
            System.arraycopy(t, 0, out, done, n);
            done += n;
        }
        return out;
    }

    private static byte[] hmac(byte[] key, byte[] data) {
        try {
            Mac mac = Mac.getInstance(HMAC);
            mac.init(new SecretKeySpec(key, HMAC));
            return mac.doFinal(data);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA256 unavailable");
        }
    }
}
