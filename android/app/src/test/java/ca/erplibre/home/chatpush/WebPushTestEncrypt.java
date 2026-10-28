package ca.erplibre.home.chatpush;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.SecureRandom;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** Sender side of RFC 8291 for tests: a fresh server key per call, records of recordSize bytes. */
final class WebPushTestEncrypt {

    private WebPushTestEncrypt() {}

    static byte[] encrypt(byte[] plaintext, byte[] uaPublic, byte[] authSecret,
            int recordSize) throws Exception {
        KeyPair server = WebPushKeys.generate();
        byte[] asPublic = WebPushKeys.encodePublic((ECPublicKey) server.getPublic());
        byte[] salt = new byte[16];
        new SecureRandom().nextBytes(salt);

        KeyAgreement ka = KeyAgreement.getInstance("ECDH");
        ka.init((ECPrivateKey) server.getPrivate());
        ka.doPhase(WebPushKeys.decodePublic(uaPublic), true);
        byte[] ecdh = ka.generateSecret();

        byte[] prkKey = Hkdf.extract(authSecret, ecdh);
        byte[] keyInfo = WebPushDecrypt.concat(
                "WebPush: info\0".getBytes(StandardCharsets.US_ASCII), uaPublic, asPublic);
        byte[] ikm = Hkdf.expand(prkKey, keyInfo, 32);
        byte[] prk = Hkdf.extract(salt, ikm);
        byte[] cek = Hkdf.expand(prk, "Content-Encoding: aes128gcm\0"
                .getBytes(StandardCharsets.US_ASCII), 16);
        byte[] nonce = Hkdf.expand(prk, "Content-Encoding: nonce\0"
                .getBytes(StandardCharsets.US_ASCII), 12);

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(salt);
        out.write(new byte[] {(byte) (recordSize >>> 24), (byte) (recordSize >>> 16),
                (byte) (recordSize >>> 8), (byte) recordSize});
        out.write(asPublic.length);
        out.write(asPublic);

        int chunk = recordSize - 17;
        int off = 0;
        long seq = 0;
        boolean last;
        do {
            int n = Math.min(chunk, plaintext.length - off);
            last = off + n >= plaintext.length;
            byte[] rec = new byte[n + 1];
            System.arraycopy(plaintext, off, rec, 0, n);
            rec[n] = (byte) (last ? 2 : 1);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(cek, "AES"),
                    new GCMParameterSpec(128, WebPushDecrypt.nonceFor(nonce, seq)));
            out.write(c.doFinal(rec));
            off += n;
            seq++;
        } while (!last);
        return out.toByteArray();
    }
}
