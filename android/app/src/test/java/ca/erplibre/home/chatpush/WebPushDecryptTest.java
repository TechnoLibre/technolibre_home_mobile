package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.fail;

import java.io.InputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECPrivateKeySpec;
import java.util.Arrays;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.Test;

public class WebPushDecryptTest {

    private static ECPrivateKey scalarKey(byte[] scalar) throws Exception {
        return (ECPrivateKey) KeyFactory.getInstance("EC").generatePrivate(
                new ECPrivateKeySpec(new BigInteger(1, scalar), WebPushKeys.params()));
    }

    private static void expect(WebPushException.Reason reason, byte[] body,
            ECPrivateKey priv, byte[] pub, byte[] auth) {
        try {
            WebPushDecrypt.decrypt(body, priv, pub, auth);
            fail("expected " + reason);
        } catch (WebPushException e) {
            assertEquals(reason, e.reason());
        }
    }

    /** RFC 8291 section 5 and appendix A, values verbatim. */
    @Test
    public void rfc8291AppendixAVectorDecrypts() throws Exception {
        byte[] body = WebPushKeys.unb64url("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml"
                + "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT"
                + "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
        byte[] auth = WebPushKeys.unb64url("BTBZMqHH6r4Tts7J_aSIgg");
        byte[] uaPub = WebPushKeys.unb64url("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx"
                + "aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
        ECPrivateKey uaPriv = scalarKey(
                WebPushKeys.unb64url("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"));
        byte[] plain = WebPushDecrypt.decrypt(body, uaPriv, uaPub, auth);
        assertEquals("When I grow up, I want to be a watermelon",
                new String(plain, StandardCharsets.UTF_8));
    }

    @Test
    public void odoo18VectorDecryptsToItsJson() throws Exception {
        String json;
        try (InputStream in = getClass().getResourceAsStream("/chatpush/odoo18_push.json")) {
            json = new String(readAll(in), StandardCharsets.UTF_8);
        }
        byte[] body = java.util.Base64.getDecoder().decode(field(json, "body"));
        byte[] pub = WebPushKeys.unb64url(field(json, "ua_public"));
        byte[] auth = WebPushKeys.unb64url(field(json, "auth"));
        ECPrivateKey priv = WebPushKeys.decodePrivate(
                java.util.Base64.getDecoder().decode(field(json, "ua_private_pkcs8")));
        String expected = field(json, "plaintext").replace("\\\"", "\"");
        byte[] plain = WebPushDecrypt.decrypt(body, priv, pub, auth);
        assertEquals(expected, new String(plain, StandardCharsets.UTF_8));
    }

    @Test
    public void a4096ByteBodyDecrypts() throws Exception {
        KeyPair ua = WebPushKeys.generate();
        byte[] pub = WebPushKeys.encodePublic((ECPublicKey) ua.getPublic());
        byte[] auth = WebPushKeys.newAuthSecret();
        StringBuilder sb = new StringBuilder("{\"body\": \"");
        while (sb.length() + 6 <= 3993 - 2) sb.append("\\u00e9");
        while (sb.length() < 3993 - 2) sb.append('x');
        sb.append("\"}");
        byte[] plain = sb.toString().getBytes(StandardCharsets.UTF_8);
        assertEquals(3993, plain.length);
        byte[] body = WebPushTestEncrypt.encrypt(plain, pub, auth, 4096);
        assertEquals(4096, body.length);
        assertArrayEquals(plain,
                WebPushDecrypt.decrypt(body, (ECPrivateKey) ua.getPrivate(), pub, auth));
    }

    @Test
    public void twoRecordsDecrypt() throws Exception {
        KeyPair ua = WebPushKeys.generate();
        byte[] pub = WebPushKeys.encodePublic((ECPublicKey) ua.getPublic());
        byte[] auth = WebPushKeys.newAuthSecret();
        byte[] plain = "twenty bytes of text".getBytes(StandardCharsets.UTF_8);
        byte[] body = WebPushTestEncrypt.encrypt(plain, pub, auth, 32);
        assertEquals(86 + 32 + (plain.length - 15 + 17), body.length);
        assertArrayEquals(plain,
                WebPushDecrypt.decrypt(body, (ECPrivateKey) ua.getPrivate(), pub, auth));
    }

    @Test
    public void aWrongAuthSecretFailsWithAuthFailed() throws Exception {
        KeyPair ua = WebPushKeys.generate();
        byte[] pub = WebPushKeys.encodePublic((ECPublicKey) ua.getPublic());
        byte[] auth = WebPushKeys.newAuthSecret();
        byte[] body = WebPushTestEncrypt.encrypt(new byte[] {1, 2, 3}, pub, auth, 4096);
        expect(WebPushException.Reason.AUTH_FAILED, body,
                (ECPrivateKey) ua.getPrivate(), pub, WebPushKeys.newAuthSecret());
    }

    @Test
    public void aFlippedCiphertextByteFailsWithAuthFailed() throws Exception {
        KeyPair ua = WebPushKeys.generate();
        byte[] pub = WebPushKeys.encodePublic((ECPublicKey) ua.getPublic());
        byte[] auth = WebPushKeys.newAuthSecret();
        byte[] body = WebPushTestEncrypt.encrypt(new byte[] {1, 2, 3}, pub, auth, 4096);
        body[90] ^= 0x01;
        expect(WebPushException.Reason.AUTH_FAILED, body,
                (ECPrivateKey) ua.getPrivate(), pub, auth);
    }

    @Test
    public void aBodyShorterThanTheHeaderIsTruncated() throws Exception {
        KeyPair ua = WebPushKeys.generate();
        byte[] pub = WebPushKeys.encodePublic((ECPublicKey) ua.getPublic());
        expect(WebPushException.Reason.TRUNCATED, new byte[20],
                (ECPrivateKey) ua.getPrivate(), pub, new byte[16]);
        byte[] auth = WebPushKeys.newAuthSecret();
        byte[] body = WebPushTestEncrypt.encrypt(new byte[] {1}, pub, auth, 4096);
        expect(WebPushException.Reason.TRUNCATED, Arrays.copyOf(body, 86),
                (ECPrivateKey) ua.getPrivate(), pub, auth);
    }

    @Test
    public void aKeyidNot65BytesIsBadHeader() throws Exception {
        KeyPair ua = WebPushKeys.generate();
        byte[] pub = WebPushKeys.encodePublic((ECPublicKey) ua.getPublic());
        byte[] auth = WebPushKeys.newAuthSecret();
        byte[] body = WebPushTestEncrypt.encrypt(new byte[] {1}, pub, auth, 4096);
        body[20] = 64;
        expect(WebPushException.Reason.BAD_HEADER, body,
                (ECPrivateKey) ua.getPrivate(), pub, auth);
    }

    @Test
    public void theExceptionMessageHoldsNoKeyBytes() throws Exception {
        KeyPair ua = WebPushKeys.generate();
        byte[] pub = WebPushKeys.encodePublic((ECPublicKey) ua.getPublic());
        byte[] auth = WebPushKeys.newAuthSecret();
        byte[] body = WebPushTestEncrypt.encrypt(new byte[] {1, 2, 3}, pub, auth, 4096);
        try {
            WebPushDecrypt.decrypt(body, (ECPrivateKey) ua.getPrivate(), pub,
                    WebPushKeys.newAuthSecret());
            fail("expected AUTH_FAILED");
        } catch (WebPushException e) {
            String m = String.valueOf(e.getMessage()) + e;
            assertEquals("AUTH_FAILED", e.getMessage());
            assertFalse(m.contains(WebPushKeys.b64url(auth)));
            assertFalse(m.contains(WebPushKeys.b64url(pub)));
            assertEquals(null, e.getCause());
        }
    }

    private static String field(String json, String name) {
        Matcher m = Pattern.compile("\"" + name + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(json);
        if (!m.find()) throw new IllegalStateException(name);
        return m.group(1);
    }

    private static byte[] readAll(InputStream in) throws Exception {
        java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        for (int n; (n = in.read(buf)) > 0; ) o.write(buf, 0, n);
        return o.toByteArray();
    }
}
