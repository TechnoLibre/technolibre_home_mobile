package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONObject;
import org.junit.Test;

public class ActionStoreTest {

    private static final String TEXT = "Bonjour Bruno Tremblay, réponse confidentielle";

    private final MapKeyValue kv = new MapKeyValue();
    private final SecretBox box = new SecretBox(() -> new SecretKeySpec(new byte[32], "AES"));
    private long now = 1_793_247_814_000L;
    private final ActionStore store = new ActionStore(kv, box, () -> now, () -> "process-un");

    private static Set<String> ids(List<ChatAction> list) {
        Set<String> out = new HashSet<>();
        for (ChatAction a : list) out.add(a.id);
        return out;
    }

    @Test
    public void anActionIsDurableAndSealedBeforeItIsClaimed() {
        ChatAction a = store.add("cfg1", ActionKind.REPLY, 4, 0, 0, TEXT);
        assertEquals(1, kv.map.size());
        for (String v : kv.map.values()) {
            assertFalse(v, v.contains("Bruno"));
            assertFalse(v, v.contains("confidentielle"));
            assertFalse(v, v.contains(a.clientUuid));
        }
        assertFalse(a.toString().contains("Bruno"));
        assertNotEquals(a.id, a.clientUuid);
        assertTrue(a.clientUuid.matches("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"));

        ActionStore reopened = new ActionStore(kv, box, () -> now, () -> "process-deux");
        ChatAction back = reopened.get(a.id);
        assertNotNull(back);
        assertEquals(TEXT, back.text);
        assertEquals(a.clientUuid, back.clientUuid);
        assertEquals(ChatAction.State.PENDING, back.state);
        assertEquals(now, back.createdAt);
        assertEquals(0L, back.sentAt);
        assertEquals(Arrays.asList(a.id), new ArrayList<>(ids(reopened.due())));
    }

    @Test
    public void claimRefusesAClaimedRecord() {
        ChatAction a = store.add("cfg1", ActionKind.MUTE, 4, 0, 0, "");
        assertTrue(store.claim(a.id));
        assertEquals(ChatAction.State.RUNNING, store.get(a.id).state);
        assertFalse(store.claim(a.id));
        assertFalse(new ActionStore(kv, box, () -> now, () -> "process-deux").claim(a.id));
        assertFalse(store.claim("absent"));
        assertTrue(store.due().isEmpty());
    }

    @Test
    public void aPendingOrRunningRecordIsNotListedForTheDrain() throws Exception {
        ChatAction pending = store.add("cfg1", ActionKind.REPLY, 4, 0, 0, TEXT);
        ChatAction running = store.add("cfg1", ActionKind.READ, 4, 0, 1_793_247_814L, "");
        store.claim(running.id);
        ChatAction done = store.add("cfg1", ActionKind.REACT, 4, 32, 0, "");
        store.claim(done.id);
        store.done(done.id, "{\"MessageReactions\":[]}");
        ChatAction handed = store.add("cfg1", ActionKind.REPLY, 4, 0, 0, TEXT);
        store.claim(handed.id);
        store.markSent(handed.id, true);
        store.markSent(handed.id, false);
        store.handoff(handed.id, "session_expired");

        List<ChatAction> drain = store.forDrain();
        assertEquals(new HashSet<>(Arrays.asList(done.id, handed.id)), ids(drain));
        assertFalse(ids(drain).contains(pending.id));
        assertFalse(ids(drain).contains(running.id));

        JSONObject d = store.get(done.id).toJson();
        assertEquals("react", d.getString("kind"));
        assertEquals("done", d.getString("state"));
        assertEquals(32, d.getLong("messageId"));
        assertEquals("👍", d.getString("content"));
        assertTrue(d.isNull("sentAt"));
        assertFalse(d.getBoolean("plainSent"));
        assertTrue(d.isNull("reason"));
        assertEquals("{\"MessageReactions\":[]}", d.getString("answer"));

        JSONObject h = store.get(handed.id).toJson();
        assertEquals("reply", h.getString("kind"));
        assertEquals("handoff", h.getString("state"));
        assertEquals("session_expired", h.getString("reason"));
        assertTrue(h.isNull("messageId"));
        assertEquals(now, h.getLong("sentAt"));
        // One send without the module is enough: a marker search comes first ever after
        assertTrue(h.getBoolean("plainSent"));
        assertEquals(TEXT, h.getString("text"));
        assertEquals("", h.getString("content"));
        assertEquals(handed.clientUuid, h.getString("clientUuid"));
        assertEquals("cfg1", h.getString("configId"));
        assertEquals(4, h.getLong("channelId"));
        assertTrue(h.isNull("answer"));
        assertEquals(1, store.handoffCount("cfg1"));
        assertEquals(0, store.handoffCount("cfg2"));
    }

    @Test
    public void ackLeavesPendingAndRunningRecords() {
        ChatAction pending = store.add("cfg1", ActionKind.MUTE, 4, 0, 0, "");
        ChatAction running = store.add("cfg1", ActionKind.MUTE, 5, 0, 0, "");
        store.claim(running.id);
        ChatAction done = store.add("cfg1", ActionKind.MUTE, 6, 0, 0, "");
        store.claim(done.id);
        store.done(done.id, null);
        ChatAction handed = store.add("cfg1", ActionKind.MUTE, 7, 0, 0, "");
        store.claim(handed.id);
        store.handoff(handed.id, "refused");

        store.ack(Arrays.asList(pending.id, running.id, done.id, handed.id, "absent"));
        assertEquals(ChatAction.State.PENDING, store.get(pending.id).state);
        assertEquals(ChatAction.State.RUNNING, store.get(running.id).state);
        assertNull(store.get(done.id));
        assertNull(store.get(handed.id));
        assertTrue(store.forDrain().isEmpty());
        assertEquals(2, kv.map.size());
    }

    @Test
    public void recoverTurnsRunningBackToPendingAndKeepsSentAt() {
        ChatAction a = store.add("cfg1", ActionKind.REPLY, 4, 0, 0, TEXT);
        store.claim(a.id);
        store.markSent(a.id, true);
        long sentAt = now;
        // The claiming process still runs it: not recovered under its feet
        assertEquals(0, store.recover());
        assertEquals(ChatAction.State.RUNNING, store.get(a.id).state);

        now += 5_000;
        ActionStore next = new ActionStore(kv, box, () -> now, () -> "process-deux");
        assertEquals(1, next.recover());
        ChatAction back = next.get(a.id);
        assertEquals(ChatAction.State.PENDING, back.state);
        assertEquals(sentAt, back.sentAt);
        assertTrue(back.plainSent);
        assertEquals(ids(next.due()), new HashSet<>(Arrays.asList(a.id)));
        assertEquals(0, next.recover());
    }

    @Test
    public void retryLaterBacksOffFromThirtySecondsToAnHour() {
        ChatAction a = store.add("cfg1", ActionKind.MUTE, 4, 0, 0, "");
        long[] expected = {30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000};
        for (long wait : expected) {
            assertTrue(store.claim(a.id));
            store.retryLater(a.id);
            ChatAction back = store.get(a.id);
            assertEquals(ChatAction.State.PENDING, back.state);
            assertEquals(now + wait, back.nextAt);
            assertTrue(store.due().isEmpty());
            now = back.nextAt;
            assertEquals(1, store.due().size());
        }
        assertEquals(expected.length, store.get(a.id).attempts);

        assertTrue(store.claim(a.id));
        store.retryAt(a.id, now + ActionStore.QUIET_MS);
        assertEquals(now + ActionStore.QUIET_MS, store.get(a.id).nextAt);
        assertEquals(expected.length, store.get(a.id).attempts);
    }

    @Test
    public void doneRecordsOlderThanSevenDaysArePruned() {
        ChatAction old = store.add("cfg1", ActionKind.MUTE, 4, 0, 0, "");
        store.claim(old.id);
        store.done(old.id, null);
        ChatAction handed = store.add("cfg1", ActionKind.MUTE, 5, 0, 0, "");
        store.claim(handed.id);
        store.handoff(handed.id, "refused");
        ChatAction pending = store.add("cfg1", ActionKind.REPLY, 6, 0, 0, TEXT);
        now += 6L * 24 * 60 * 60 * 1000;
        ChatAction recent = store.add("cfg1", ActionKind.MUTE, 7, 0, 0, "");
        store.claim(recent.id);
        store.done(recent.id, null);

        now += 24L * 60 * 60 * 1000 + 1;
        assertEquals(1, store.prune());
        assertNull(store.get(old.id));
        assertNotNull(store.get(recent.id));
        assertNotNull(store.get(handed.id));
        assertNotNull(store.get(pending.id));
    }

    @Test
    public void unreadableRecordsArePruned() throws Exception {
        ChatAction kept = store.add("cfg1", ActionKind.REPLY, 4, 0, 0, TEXT);
        kv.put("act:seal-casse", "v1:bad:bad");
        kv.put("act:pas-json", box.seal("pas du json".getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        kv.put("autre:cle", "v1:bad:bad");
        assertEquals(2, store.prune());
        assertNull(kv.get("act:seal-casse"));
        assertNull(kv.get("act:pas-json"));
        assertNotNull(kv.get("autre:cle"));
        assertNotNull(store.get(kept.id));
        assertEquals(0, store.prune());
    }

    @Test
    public void aKeystoreFaultPrunesNothing() {
        boolean[] fault = {false};
        SecretBox flaky = new SecretBox(() -> {
            if (fault[0]) throw new java.security.ProviderException("keystore unavailable");
            return new SecretKeySpec(new byte[32], "AES");
        });
        ActionStore flakyStore = new ActionStore(kv, flaky, () -> now, () -> "process-un");
        ChatAction reply = flakyStore.add("cfg1", ActionKind.REPLY, 4, 0, 0, TEXT);
        ChatAction handed = flakyStore.add("cfg1", ActionKind.MUTE, 5, 0, 0, "");
        flakyStore.claim(handed.id);
        flakyStore.handoff(handed.id, "session_expired");

        fault[0] = true;
        assertEquals(0, flakyStore.prune());
        assertEquals(2, kv.map.size());

        fault[0] = false;
        assertEquals(TEXT, flakyStore.get(reply.id).text);
        assertEquals(ChatAction.State.HANDOFF, flakyStore.get(handed.id).state);
    }

    @Test
    public void anUnreadableRecordStaysWhileNoOtherRecordOpens() {
        kv.put("act:seal-casse", "v1:bad:bad");
        assertEquals(0, store.prune());
        assertNotNull(kv.get("act:seal-casse"));
        // A record that opens proves the key: the broken seal goes
        store.add("cfg1", ActionKind.MUTE, 4, 0, 0, "");
        assertEquals(1, store.prune());
        assertNull(kv.get("act:seal-casse"));
    }

    @Test
    public void aReplyWaitsForTheOlderRepliesOfItsConversation() {
        ChatAction first = store.add("cfg1", ActionKind.REPLY, 4, 0, 0, TEXT);
        now += 1;
        ChatAction second = store.add("cfg1", ActionKind.REPLY, 4, 0, 0, "Encore");
        ChatAction elsewhere = store.add("cfg1", ActionKind.REPLY, 5, 0, 0, "Ailleurs");
        ChatAction mute = store.add("cfg1", ActionKind.MUTE, 4, 0, 0, "");
        // An older reply of the conversation still PENDING holds the next one back
        assertFalse(store.claim(second.id));
        assertEquals(ChatAction.State.PENDING, store.get(second.id).state);
        assertTrue(store.claim(elsewhere.id));
        assertTrue(store.claim(mute.id));

        assertTrue(store.claim(first.id));
        assertFalse(store.claim(second.id));
        // Its run may die with its process: the next one comes back no earlier than a run for it
        assertEquals(now + ActionStore.FIRST_RETRY_MS, store.get(second.id).nextAt);

        store.retryAt(first.id, now + 600_000);
        assertFalse(store.claim(second.id));
        assertEquals(now + 600_000, store.get(second.id).nextAt);

        assertTrue(store.claim(first.id));
        store.done(first.id, null);
        assertTrue(store.claim(second.id));
    }

    @Test
    public void handoffCountsListsEveryAccountWaitingForTheApp() {
        assertTrue(store.handoffCounts().isEmpty());
        for (String config : new String[] {"cfg1", "cfg1", "cfg2"}) {
            ChatAction a = store.add(config, ActionKind.MUTE, 4, 0, 0, "");
            store.claim(a.id);
            store.handoff(a.id, "refused");
        }
        ChatAction done = store.add("cfg3", ActionKind.MUTE, 4, 0, 0, "");
        store.claim(done.id);
        store.done(done.id, null);
        store.add("cfg4", ActionKind.MUTE, 4, 0, 0, "");
        java.util.Map<String, Integer> counts = store.handoffCounts();
        assertEquals(2, counts.size());
        assertEquals(Integer.valueOf(2), counts.get("cfg1"));
        assertEquals(Integer.valueOf(1), counts.get("cfg2"));
    }

    @Test
    public void wakeAtIsTheEarliestPendingOrSoonAfterARunningRecord() {
        assertEquals(0L, store.wakeAt());
        ChatAction late = store.add("cfg1", ActionKind.MUTE, 4, 0, 0, "");
        store.retryAt(late.id, now + 600_000);
        ChatAction soon = store.add("cfg1", ActionKind.MUTE, 5, 0, 0, "");
        store.retryAt(soon.id, now + 60_000);
        assertEquals(now + 60_000, store.wakeAt());
        // a RUNNING record may die with its process: a run comes back for it
        ChatAction running = store.add("cfg1", ActionKind.MUTE, 6, 0, 0, "");
        assertTrue(store.claim(running.id));
        assertEquals(now + ActionStore.FIRST_RETRY_MS, store.wakeAt());
        // DONE and HANDOFF records wait for the app, not for native code
        store.done(running.id, null);
        store.done(soon.id, null);
        store.handoff(late.id, "refused");
        assertEquals(0L, store.wakeAt());
    }
}
