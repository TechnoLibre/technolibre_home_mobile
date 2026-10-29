package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import javax.crypto.spec.SecretKeySpec;
import org.junit.Test;

public class NativeSessionsTest {

    private final MapKeyValue kv = new MapKeyValue();
    private final SecretBox box = new SecretBox(() -> new SecretKeySpec(new byte[32], "AES"));
    private long now = 1_000_000L;
    private final NativeSessions sessions = new NativeSessions(kv, box, () -> now);

    @Test
    public void onlyTheSessionTriedIsMarkedDead() {
        String url = "http://odoo.exemple.test:8069";
        NativeSession old = new NativeSession("cfg1", url, "db_exemple", "sid_exemple_vieux", 5L);
        sessions.put(old);
        // A new session mirrored after the old one was tried
        sessions.put(new NativeSession("cfg1", url, "db_exemple", "sid_exemple_neuf", 6L));
        assertFalse(sessions.markExpired("cfg1", old));
        assertFalse(sessions.expired("cfg1"));
        sessions.forget("cfg1");
        assertFalse(sessions.markExpired("cfg1", old));
        assertFalse(sessions.expired("cfg1"));
    }

    @Test
    public void aSessionIsStoredSealedAndHidden() {
        NativeSession s = new NativeSession("cfg1", "http://odoo.exemple.test:8069", "db_exemple", "sid_exemple_secret", 5L);
        sessions.put(s);
        for (String v : kv.map.values()) assertFalse(v.contains("sid_exemple_secret"));
        assertEquals("sid_exemple_secret", sessions.get("cfg1").sessionId);
        assertFalse(s.toString().contains("sid_exemple_secret"));
        assertTrue(sessions.markExpired("cfg1", s));
        assertTrue(sessions.expired("cfg1"));
        sessions.put(s);
        assertFalse(sessions.expired("cfg1"));
        sessions.forget("cfg1");
        assertNull(sessions.get("cfg1"));
    }

    @Test
    public void pendingUnregistersExpireAfterSevenDays() {
        sessions.addPendingUnregister("cfg1", "http://ntfy.exemple.test/upab12cd34topic");
        sessions.addPendingUnregister("cfg1", "http://ntfy.exemple.test/upab12cd34topic");
        assertEquals(1, sessions.pending().size());
        assertEquals("http://ntfy.exemple.test/upab12cd34topic", sessions.pending().get(0).endpoint);
        for (String v : kv.map.values()) assertFalse(v.contains("upab12cd34topic"));
        now += NativeSessions.PENDING_MAX_AGE_MS + 1;
        assertTrue(sessions.pending().isEmpty());
        sessions.addPendingUnregister("cfg2", "e");
        sessions.donePending("cfg2");
        assertTrue(sessions.pending().isEmpty());
    }

    @Test
    public void anUnreadableEntryDropsOnlyItself() throws Exception {
        sessions.addPendingUnregister("cfg1", "endpoint-un");
        sessions.addPendingUnregister("cfg1", "endpoint-deux");
        org.json.JSONArray arr = new org.json.JSONArray(kv.map.get("pend:cfg1"));
        arr.getJSONObject(0).put("ep", "v1:bad:bad");
        kv.map.put("pend:cfg1", arr.toString());
        assertEquals(1, sessions.pending().size());
        assertEquals("endpoint-deux", sessions.pending().get(0).endpoint);
    }

    @Test
    public void donePendingRemovesOnlyTheEndpointsSent() {
        sessions.addPendingUnregister("cfg1", "endpoint-un");
        sessions.addPendingUnregister("cfg1", "endpoint-deux");
        sessions.donePending("cfg1", java.util.Collections.singleton("endpoint-un"));
        assertEquals(1, sessions.pending().size());
        assertEquals("endpoint-deux", sessions.pending().get(0).endpoint);
        sessions.donePending("cfg1", java.util.Collections.singleton("endpoint-deux"));
        assertTrue(sessions.pending().isEmpty());
        assertFalse(kv.map.containsKey("pend:cfg1"));
    }

    @Test
    public void configIdsListsTheStoredSessions() {
        sessions.put(new NativeSession("cfg1", "https://odoo.exemple.test", "db_exemple", "sid_exemple_secret", 5L));
        sessions.put(new NativeSession("cfg2", "https://odoo.exemple.test", "db_exemple", "sid_exemple_secret", 5L));
        sessions.addPendingUnregister("cfg3", "endpoint-un");
        assertEquals(new java.util.HashSet<>(java.util.Arrays.asList("cfg1", "cfg2")), sessions.configIds());
    }
}
