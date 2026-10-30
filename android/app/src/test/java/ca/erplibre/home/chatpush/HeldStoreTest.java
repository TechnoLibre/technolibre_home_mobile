package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.security.interfaces.ECPublicKey;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public class HeldStoreTest {

    private static final String LINK = "https://ntfy.exemple.test";
    private static final String TOPIC = "upab12cd34heldtopicexemple0000";

    private final MapKeyValue kv = new MapKeyValue();
    private long now = 1_790_000_000_000L;
    private final HeldStore held = new HeldStore(kv, () -> now);

    private static NtfyMessage message(String id, byte[] body) throws Exception {
        return NtfyMessage.parse("{\"id\":\"" + id + "\",\"time\":1790000000,\"event\":\"message\",\"topic\":\""
                + TOPIC + "\",\"message\":\"" + B64.encode(body, false) + "\",\"encoding\":\"base64\"}");
    }

    private static NtfyMessage message(String id) throws Exception {
        return message(id, ("corps chiffré " + id).getBytes(StandardCharsets.UTF_8));
    }

    private static List<Long> messageIds(List<HeldStore.Held> list) {
        List<Long> out = new ArrayList<>();
        for (HeldStore.Held h : list) out.add(h.messageId);
        return out;
    }

    @Test
    public void aHeldMessageIsStoredAsCiphertextOnly() throws Exception {
        byte[] plain = PushPayloadTest.resource("push16_chat_browser_online.json");
        java.security.KeyPair pair = WebPushKeys.generate();
        byte[] cipher = WebPushTestEncrypt.encrypt(plain,
                WebPushKeys.encodePublic((ECPublicKey) pair.getPublic()), WebPushKeys.newAuthSecret(), 4096);
        held.add(LINK, message("m1", cipher), "cfg1", 4, 26, now + 10_000);
        String text = new String(plain, StandardCharsets.UTF_8);
        for (String raw : kv.map.values()) {
            assertFalse(raw.contains("MS Chat"));
            assertFalse(raw.contains("browser_online"));
            assertFalse(raw.contains("devant ton"));
            assertFalse(raw.contains(B64.encode(plain, false)));
            assertFalse(raw.contains(text));
        }
        HeldStore.Held back = held.of(LINK).get(0);
        assertArrayEquals(cipher, back.message.body);
        assertEquals("m1", back.message.id);
        assertEquals(TOPIC, back.message.topic);
        assertEquals(1_790_000_000L, back.message.time);
        assertEquals("cfg1", back.configId);
        assertEquals(4L, back.channelId);
        assertEquals(26L, back.messageId);
        assertEquals(LINK, back.linkUrl);
    }

    @Test
    public void dropReadRemovesHeldIdsUpToTheReadPointOnly() throws Exception {
        held.add(LINK, message("m5"), "cfg1", 4, 5, now + 10);
        held.add(LINK, message("m7"), "cfg1", 4, 7, now + 20);
        held.add(LINK, message("m9"), "cfg1", 4, 9, now + 30);
        held.add(LINK, message("m6"), "cfg1", 3, 6, now + 40);
        held.add(LINK, message("o5"), "cfg2", 4, 5, now + 50);
        assertEquals(2, held.dropRead("cfg1", 4, 7));
        assertEquals(Arrays.asList(9L, 6L, 5L), messageIds(held.of(LINK)));
        assertEquals(0, held.dropRead("cfg1", 4, 8));
    }

    @Test
    public void dueListsEntriesByDueTime() throws Exception {
        held.add(LINK, message("c"), "cfg1", 4, 3, now + 300);
        held.add(LINK, message("a"), "cfg1", 4, 1, now + 100);
        held.add(LINK, message("b"), "cfg1", 4, 2, now + 200);
        held.add("https://autre.exemple.test", message("d"), "cfg2", 4, 4, now + 150);
        assertEquals(Arrays.asList(1L, 4L, 2L), messageIds(held.due(now + 250)));
        assertEquals(Arrays.asList(1L, 2L, 3L), messageIds(held.of(LINK)));
        assertEquals(now + 300, held.latestDue());
        assertFalse(held.isEmpty());
        for (String id : Arrays.asList("a", "b", "c", "d")) held.remove(id);
        assertTrue(held.isEmpty());
        assertEquals(0L, held.latestDue());
        assertTrue(kv.map.isEmpty());
    }

    @Test
    public void aMessageHeldAgainKeepsItsFirstDueTime() throws Exception {
        held.add(LINK, message("m1"), "cfg1", 4, 26, now + 100);
        held.add(LINK, message("m1"), "cfg1", 4, 26, now + 900);
        assertEquals(1, held.of(LINK).size());
        assertEquals(now + 100, held.latestDue());
    }

    @Test
    public void beyondMaxTheOldestEntryIsDueAtOnce() throws Exception {
        for (int i = 0; i <= HeldStore.MAX; i++) {
            held.add(LINK, message("m" + i), "cfg1", 4, i + 1, now + 10_000 + i);
        }
        List<HeldStore.Held> due = held.due(now);
        assertEquals(1, due.size());
        assertEquals("m0", due.get(0).message.id);
        assertEquals(HeldStore.MAX + 1, held.of(LINK).size());
    }

    @Test
    public void anUnreadableEntryIsRemovedAndCounted() throws Exception {
        kv.put("held:m0", "{\"link\":");
        held.add(LINK, message("m1"), "cfg1", 4, 26, now + 10);
        assertEquals(1, held.of(LINK).size());
        assertFalse(kv.map.containsKey("held:m0"));
        assertEquals(1, held.takeUnreadable());
        assertEquals(0, held.takeUnreadable());
    }

    @Test
    public void linkUrlsNamesEveryServerHolding() throws Exception {
        held.add(LINK, message("a"), "cfg1", 4, 1, now + 100);
        held.add(LINK, message("b"), "cfg1", 4, 2, now + 200);
        held.add("https://autre.exemple.test", message("c"), "cfg2", 4, 3, now + 150);
        assertEquals(new java.util.HashSet<>(Arrays.asList(LINK, "https://autre.exemple.test")), held.linkUrls());
    }
}
