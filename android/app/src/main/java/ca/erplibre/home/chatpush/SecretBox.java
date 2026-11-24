package ca.erplibre.home.chatpush;

import java.security.GeneralSecurityException;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Seals a secret as "v1:&lt;b64 iv&gt;:&lt;b64 ciphertext&gt;" (AES-256-GCM,
 * 12-byte iv drawn by the cipher, tag in the ciphertext). The key comes from
 * a KeyProvider, the Android Keystore on the device.
 *
 * Every failure is a GeneralSecurityException, the Keystore's
 * ProviderException (a RuntimeException) included: a caller that drops an
 * unreadable secret then never lets a Keystore fault escape.
 */
final class SecretBox {

    interface KeyProvider {
        SecretKey key() throws GeneralSecurityException;
    }

    private static final String PREFIX = "v1:";
    private static final int TAG_BITS = 128;
    private static final int IV_LEN = 12;

    private final KeyProvider provider;

    SecretBox(KeyProvider provider) {
        this.provider = provider;
    }

    String seal(byte[] plain) throws GeneralSecurityException {
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, provider.key());
            byte[] ct = c.doFinal(plain);
            return PREFIX + B64.encode(c.getIV(), false) + ":" + B64.encode(ct, false);
        } catch (RuntimeException e) {
            throw new GeneralSecurityException("keystore fault");
        }
    }

    /** Throws GeneralSecurityException on an unknown version, a malformed seal, a failed tag or a Keystore fault. */
    byte[] open(String sealed) throws GeneralSecurityException {
        if (sealed == null || !sealed.startsWith(PREFIX)) {
            throw new GeneralSecurityException("unknown seal version");
        }
        String[] parts = sealed.substring(PREFIX.length()).split(":", -1);
        if (parts.length != 2) throw new GeneralSecurityException("malformed seal");
        byte[] iv;
        byte[] ct;
        try {
            iv = B64.decode(parts[0]);
            ct = B64.decode(parts[1]);
        } catch (IllegalArgumentException e) {
            throw new GeneralSecurityException("malformed seal");
        }
        if (iv.length != IV_LEN) throw new GeneralSecurityException("malformed seal");
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, provider.key(), new GCMParameterSpec(TAG_BITS, iv));
            return c.doFinal(ct);
        } catch (RuntimeException e) {
            throw new GeneralSecurityException("keystore fault");
        }
    }
}
