package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class B64Test {

    @Test
    public void matchesTheJdkCodecForEveryLength() {
        java.util.Random r = new java.util.Random(7);
        for (int n = 0; n < 40; n++) {
            byte[] b = new byte[n];
            r.nextBytes(b);
            assertEquals(java.util.Base64.getEncoder().encodeToString(b), B64.encode(b, false));
            assertEquals(java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(b),
                    B64.encode(b, true));
            assertArrayEquals(b, B64.decode(B64.encode(b, false)));
            assertArrayEquals(b, B64.decode(B64.encode(b, true)));
        }
    }

    @Test(expected = IllegalArgumentException.class)
    public void garbageIsRefused() {
        B64.decode("ab$d");
    }
}
