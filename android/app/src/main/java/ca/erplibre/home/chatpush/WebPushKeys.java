package ca.erplibre.home.chatpush;

import java.math.BigInteger;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.security.spec.PKCS8EncodedKeySpec;

/**
 * P-256 key material of a Web Push subscription. Software keys: minSdk 24
 * has no Keystore ECDH, so the private key is sealed by SecretBox at rest.
 */
final class WebPushKeys {

    static final int PUBLIC_LEN = 65;
    static final int AUTH_LEN = 16;
    private static final SecureRandom RANDOM = new SecureRandom();

    private WebPushKeys() {}

    static KeyPair generate() {
        try {
            KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
            g.initialize(new ECGenParameterSpec("secp256r1"), RANDOM);
            return g.generateKeyPair();
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("P-256 key generation unavailable");
        }
    }

    /** Uncompressed point: 0x04 || X || Y, 32 bytes each. */
    static byte[] encodePublic(ECPublicKey k) {
        byte[] out = new byte[PUBLIC_LEN];
        out[0] = 0x04;
        copyFixed(k.getW().getAffineX(), out, 1);
        copyFixed(k.getW().getAffineY(), out, 33);
        return out;
    }

    /** Throws IllegalArgumentException on a wrong length, prefix or a point off the curve. */
    static ECPublicKey decodePublic(byte[] raw) {
        if (raw == null || raw.length != PUBLIC_LEN || raw[0] != 0x04) {
            throw new IllegalArgumentException("not an uncompressed P-256 point");
        }
        try {
            ECPoint w = new ECPoint(
                    new BigInteger(1, java.util.Arrays.copyOfRange(raw, 1, 33)),
                    new BigInteger(1, java.util.Arrays.copyOfRange(raw, 33, 65)));
            return (ECPublicKey) KeyFactory.getInstance("EC")
                    .generatePublic(new ECPublicKeySpec(w, params()));
        } catch (GeneralSecurityException e) {
            throw new IllegalArgumentException("not a P-256 point");
        }
    }

    static ECPrivateKey decodePrivate(byte[] pkcs8) {
        try {
            return (ECPrivateKey) KeyFactory.getInstance("EC")
                    .generatePrivate(new PKCS8EncodedKeySpec(pkcs8));
        } catch (GeneralSecurityException e) {
            throw new IllegalArgumentException("not a PKCS#8 P-256 key");
        }
    }

    /** The 16-byte authentication secret of RFC 8291. */
    static byte[] newAuthSecret() {
        byte[] b = new byte[AUTH_LEN];
        RANDOM.nextBytes(b);
        return b;
    }

    /** URL-safe base64 without padding. */
    static String b64url(byte[] b) {
        return B64.encode(b, true);
    }

    /** Accepts padded or unpadded input; throws IllegalArgumentException on garbage. */
    static byte[] unb64url(String s) {
        return B64.decode(s);
    }

    static ECParameterSpec params() throws GeneralSecurityException {
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(new ECGenParameterSpec("secp256r1"));
        return ((ECPublicKey) g.generateKeyPair().getPublic()).getParams();
    }

    private static void copyFixed(BigInteger v, byte[] out, int at) {
        byte[] b = v.toByteArray();
        int skip = b.length > 32 ? b.length - 32 : 0;
        int len = b.length - skip;
        System.arraycopy(b, skip, out, at + 32 - len, len);
    }
}
