package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.util.List;
import java.util.regex.Pattern;
import javax.crypto.spec.SecretKeySpec;
import org.junit.Before;
import org.junit.Test;

public class PushStoreTest {

    private static final String URL = "http://ntfy.exemple.test:8080";
    private static final String TOKEN = "tk_exempleexempleexempleexemple";

    private MapKeyValue kv;
    private PushStore store;

    @Before
    public void setUp() {
        kv = new MapKeyValue();
        SecretBox box = new SecretBox(() -> new SecretKeySpec(new byte[32], "AES"));
        store = new PushStore(kv, box);
        store.putNtfy(new NtfyServer(URL, TOKEN, "upab12cd34", 43200));
    }

    @Test
    public void aSubscriptionIsKeptUntilRenewed() {
        Subscription a = store.subscribe("cfg1", URL, false);
        assertTrue(Pattern.matches("upab12cd34[a-z0-9]{22}", a.topic));
        Subscription again = store.subscribe("cfg1", URL, false);
        assertEquals(a.topic, again.topic);
        assertArrayEquals(a.publicKey, again.publicKey);
        assertArrayEquals(a.authSecret, again.authSecret);
        assertNotNull(again.privateKey());
        Subscription renewed = store.subscribe("cfg1", URL, true);
        assertNotEquals(a.topic, renewed.topic);
        assertFalse(java.util.Arrays.equals(a.publicKey, renewed.publicKey));
    }

    @Test
    public void aNewPrefixRenewsEverySubscriptionOfThatNtfy() {
        Subscription a = store.subscribe("cfg1", URL, false);
        Subscription b = store.subscribe("cfg2", URL, false);
        store.putNtfy(new NtfyServer(URL, TOKEN, "upzz99yy88", 43200));
        Subscription a2 = store.subscribe("cfg1", URL, false);
        Subscription b2 = store.subscribe("cfg2", URL, false);
        assertNotEquals(a.topic, a2.topic);
        assertNotEquals(b.topic, b2.topic);
        assertTrue(a2.topic.startsWith("upzz99yy88"));
        assertEquals(2, store.subscriptions(URL + "/").size());
    }

    @Test
    public void aShorterPrefixThatTheOldTopicStartsWithStillRenews() {
        Subscription a = store.subscribe("cfg1", URL, false);
        store.putNtfy(new NtfyServer(URL, TOKEN, "upab12cd3", 43200));
        Subscription b = store.subscribe("cfg1", URL, false);
        assertNotEquals(a.topic, b.topic);
        assertTrue(Pattern.matches("upab12cd3[a-z0-9]{22}", b.topic));
    }

    @Test
    public void byTopicFindsTheAccount() {
        store.subscribe("cfg1", URL, false);
        Subscription b = store.subscribe("cfg2", URL, false);
        assertEquals("cfg2", store.byTopic(b.topic).configId);
        assertNull(store.byTopic("upab12cd34nothing"));
        assertEquals(TOKEN, store.ntfy("HTTP://NTFY.exemple.test:8080/").token);
        List<NtfyServer> all = store.ntfys();
        assertEquals(1, all.size());
    }

    @Test
    public void secretsAreStoredSealed() {
        Subscription s = store.subscribe("cfg1", URL, false);
        byte[] priv = s.privateKey().getEncoded();
        String privStd = B64.encode(priv, false);
        String privUrl = B64.encode(priv, true);
        String authStd = B64.encode(s.authSecret, false);
        String authUrl = B64.encode(s.authSecret, true);
        for (String raw : kv.map.values()) {
            assertFalse(raw.contains("tk_"));
            assertFalse(raw.contains(privStd));
            assertFalse(raw.contains(privUrl));
            assertFalse(raw.contains(authStd));
            assertFalse(raw.contains(authUrl));
        }
        assertNotNull(store.ntfy(URL));
        for (byte[] secret : new byte[][] {priv, s.authSecret}) {
            StringBuilder hex = new StringBuilder();
            for (byte b : secret) hex.append(String.format("%02x", b));
            for (String raw : kv.map.values()) assertFalse(raw.contains(hex.toString()));
        }
    }

    @Test
    public void unsubscribeForgetsKeysAndTopic() {
        Subscription s = store.subscribe("cfg1", URL, false);
        store.unsubscribe("cfg1");
        assertNull(store.subscription("cfg1"));
        assertNull(store.byTopic(s.topic));
        for (String k : kv.map.keySet()) assertFalse(k.startsWith("sub:"));
    }

    @Test
    public void cursorAndContactTimeRoundTrip() {
        assertNull(store.cursor(URL));
        assertEquals(0L, store.lastContactAt(URL));
        store.setCursor(URL, "abc123", 1700000000000L);
        assertEquals("abc123", store.cursor(URL + "/"));
        assertEquals(1700000000000L, store.lastContactAt(URL));
        SeenIds seen = store.seen(URL);
        assertTrue(seen.add("m1"));
        store.saveSeen(URL, seen);
        assertFalse(store.seen(URL).add("m1"));
        store.removeNtfy(URL);
        assertNull(store.ntfy(URL));
        assertNull(store.cursor(URL));
    }
}
