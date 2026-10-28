package ca.erplibre.home.chatpush;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.interfaces.ECPrivateKey;
import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Web Push message decryption: RFC 8291 key derivation over the RFC 8188
 * aes128gcm content coding. The header is salt(16) || rs(4, big endian) ||
 * idlen(1) || keyid, where keyid is the sender's 65-byte public key.
 */
final class WebPushDecrypt {

    private static final int HEADER_FIXED = 21;
    private static final int TAG_LEN = 16;
    private static final byte[] KEY_INFO = ascii("WebPush: info\0");
    private static final byte[] CEK_INFO = ascii("Content-Encoding: aes128gcm\0");
    private static final byte[] NONCE_INFO = ascii("Content-Encoding: nonce\0");

    private WebPushDecrypt() {}

    /**
     * Returns the plaintext of an aes128gcm body for the subscription whose
     * key pair is (uaPrivate, uaPublic) and whose auth secret is authSecret.
     * Every record is authenticated and its padding delimiter checked: 0x01
     * on all but the last record, 0x02 on the last one, so a truncated
     * body is refused. Failures carry only a Reason.
     */
    static byte[] decrypt(byte[] body, ECPrivateKey uaPrivate, byte[] uaPublic,
            byte[] authSecret) throws WebPushException {
        if (body == null || body.length < HEADER_FIXED) {
            throw new WebPushException(WebPushException.Reason.TRUNCATED);
        }
        long rs = ((body[16] & 0xffL) << 24) | ((body[17] & 0xffL) << 16)
                | ((body[18] & 0xffL) << 8) | (body[19] & 0xffL);
        int idlen = body[20] & 0xff;
        if (idlen != WebPushKeys.PUBLIC_LEN || rs < TAG_LEN + 2) {
            throw new WebPushException(WebPushException.Reason.BAD_HEADER);
        }
        int dataStart = HEADER_FIXED + idlen;
        if (body.length <= dataStart) {
            throw new WebPushException(WebPushException.Reason.TRUNCATED);
        }
        byte[] salt = java.util.Arrays.copyOfRange(body, 0, 16);
        byte[] keyid = java.util.Arrays.copyOfRange(body, HEADER_FIXED, dataStart);

        byte[] cek;
        byte[] baseNonce;
        try {
            byte[] ecdh = ecdh(uaPrivate, keyid);
            byte[] prkKey = Hkdf.extract(authSecret, ecdh);
            byte[] info = concat(KEY_INFO, uaPublic, keyid);
            byte[] ikm = Hkdf.expand(prkKey, info, 32);
            byte[] prk = Hkdf.extract(salt, ikm);
            cek = Hkdf.expand(prk, CEK_INFO, 16);
            baseNonce = Hkdf.expand(prk, NONCE_INFO, 12);
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            throw new WebPushException(WebPushException.Reason.BAD_HEADER);
        }

        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        int pos = dataStart;
        long seq = 0;
        while (pos < body.length) {
            int len = (int) Math.min(rs, (long) (body.length - pos));
            boolean last = pos + len >= body.length;
            if (len < TAG_LEN + 1) {
                throw new WebPushException(WebPushException.Reason.TRUNCATED);
            }
            byte[] plain = openRecord(cek, nonceFor(baseNonce, seq), body, pos, len);
            int end = plain.length;
            while (end > 0 && plain[end - 1] == 0) end--;
            if (end == 0) throw new WebPushException(WebPushException.Reason.BAD_PADDING);
            int delimiter = plain[end - 1];
            if (delimiter != (last ? 2 : 1)) {
                throw new WebPushException(WebPushException.Reason.BAD_PADDING);
            }
            out.write(plain, 0, end - 1);
            pos += len;
            seq++;
        }
        return out.toByteArray();
    }

    private static byte[] ecdh(ECPrivateKey priv, byte[] serverPublic)
            throws GeneralSecurityException {
        KeyAgreement ka = KeyAgreement.getInstance("ECDH");
        ka.init(priv);
        ka.doPhase(WebPushKeys.decodePublic(serverPublic), true);
        return ka.generateSecret();
    }

    private static byte[] openRecord(byte[] cek, byte[] nonce, byte[] body, int off, int len)
            throws WebPushException {
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(cek, "AES"),
                    new GCMParameterSpec(TAG_LEN * 8, nonce));
            return c.doFinal(body, off, len);
        } catch (AEADBadTagException e) {
            throw new WebPushException(WebPushException.Reason.AUTH_FAILED);
        } catch (GeneralSecurityException e) {
            throw new WebPushException(WebPushException.Reason.AUTH_FAILED);
        }
    }

    /** The base nonce with the record sequence number XORed into its last 8 bytes. */
    static byte[] nonceFor(byte[] base, long seq) {
        byte[] n = base.clone();
        for (int i = 0; i < 8; i++) {
            n[n.length - 1 - i] ^= (byte) (seq >>> (8 * i));
        }
        return n;
    }

    static byte[] concat(byte[]... parts) {
        int total = 0;
        for (byte[] p : parts) total += p.length;
        byte[] out = new byte[total];
        int at = 0;
        for (byte[] p : parts) {
            System.arraycopy(p, 0, out, at, p.length);
            at += p.length;
        }
        return out;
    }

    private static byte[] ascii(String s) {
        return s.getBytes(StandardCharsets.US_ASCII);
    }
}
