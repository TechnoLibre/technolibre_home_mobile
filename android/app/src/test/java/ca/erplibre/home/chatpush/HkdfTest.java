package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertArrayEquals;

import org.junit.Test;

public class HkdfTest {

    static byte[] hex(String s) {
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        }
        return out;
    }

    /** RFC 5869 appendix A.1, test case 1 (SHA-256). */
    @Test
    public void rfc5869TestCase1() {
        byte[] ikm = hex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b");
        byte[] salt = hex("000102030405060708090a0b0c");
        byte[] info = hex("f0f1f2f3f4f5f6f7f8f9");
        byte[] prk = Hkdf.extract(salt, ikm);
        assertArrayEquals(hex("077709362c2e32df0ddc3f0dc47bba63"
                + "90b6c73bb50f9c3122ec844ad7c2b3e5"), prk);
        assertArrayEquals(hex("3cb25f25faacd57a90434f64d0362f2a"
                + "2d2d0a90cf1a5a4c5db02d56ecc4c5bf"
                + "34007208d5b887185865"), Hkdf.expand(prk, info, 42));
    }
}
