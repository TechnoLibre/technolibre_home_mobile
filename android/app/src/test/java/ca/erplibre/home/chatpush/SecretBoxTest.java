package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import org.junit.Test;

public class SecretBoxTest {

    private final SecretKey key = new SecretKeySpec(new byte[32], "AES");
    private final SecretBox box = new SecretBox(() -> key);
    private final byte[] secret = "tk_abcdefgh".getBytes(StandardCharsets.UTF_8);

    @Test
    public void sealThenOpen() throws Exception {
        String sealed = box.seal(secret);
        assertTrue(sealed.startsWith("v1:"));
        assertArrayEquals(secret, box.open(sealed));
    }

    @Test
    public void twoSealsDiffer() throws Exception {
        assertFalse(box.seal(secret).equals(box.seal(secret)));
    }

    @Test
    public void aTamperedSealFails() throws Exception {
        String sealed = box.seal(secret);
        int mid = sealed.lastIndexOf(':') + 1 + (sealed.length() - sealed.lastIndexOf(':') - 1) / 2;
        char c = sealed.charAt(mid) == 'A' ? 'B' : 'A';
        try {
            box.open(sealed.substring(0, mid) + c + sealed.substring(mid + 1));
            fail("expected GeneralSecurityException");
        } catch (GeneralSecurityException expected) {
            // the tag no longer matches
        }
    }

    @Test
    public void aShortIvFails() throws Exception {
        String sealed = box.seal(secret);
        String[] parts = sealed.substring(3).split(":");
        String shortIv = B64.encode(new byte[8], false);
        try {
            box.open("v1:" + shortIv + ":" + parts[1]);
            fail("expected GeneralSecurityException");
        } catch (GeneralSecurityException expected) {
            // the iv must be 12 bytes
        }
    }

    @Test
    public void anUnknownVersionPrefixFails() throws Exception {
        String sealed = box.seal(secret);
        try {
            box.open("v2" + sealed.substring(2));
            fail("expected GeneralSecurityException");
        } catch (GeneralSecurityException expected) {
            // only v1 is known
        }
    }
}
