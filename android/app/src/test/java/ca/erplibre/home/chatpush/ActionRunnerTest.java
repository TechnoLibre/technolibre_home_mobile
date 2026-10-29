package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import javax.crypto.spec.SecretKeySpec;
import okhttp3.OkHttpClient;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import okhttp3.mockwebserver.SocketPolicy;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** The action runner against the answers Odoo 18 really gave (resources chatpush/actions), on a manual clock. */
public class ActionRunnerTest {

    /** The uuid the captured marker search answer carries; replaced by the record's own. */
    private static final String CAPTURED_UUID = "24ff0bf7-76b8-4caf-ad92-a71df8436306";
    private static final String SID = "sid_exemple_secret";
    private static final String TEXT = "Bonjour du test d'action";
    private static final long HOUR = 3_600_000L;

    private MockWebServer server;
    private long now = 1_793_247_814_000L;
    private final SecretBox box = new SecretBox(() -> new SecretKeySpec(new byte[32], "AES"));
    private final MapKeyValue actionKv = new MapKeyValue();
    private final MapKeyValue sessionKv = new MapKeyValue();
    private ActionStore store;
    private NativeSessions sessions;
    private PushSettingsStore settings;
    private ActionRunner runner;
    private NativeSession session;

    @Before
    public void setUp() throws Exception {
        server = new MockWebServer();
        server.start();
        store = new ActionStore(actionKv, box, () -> now, () -> "process-un");
        sessions = new NativeSessions(sessionKv, box, () -> now);
        settings = new PushSettingsStore(new MapKeyValue());
        session = new NativeSession("cfg1", server.url("/").toString(), "exemple_db", SID, 1L);
        sessions.put(session);
        mirror("1.5");
        runner = new ActionRunner(store, sessions, settings, new OdooActions(new OkHttpClient()), () -> now);
    }

    @After
    public void tearDown() throws Exception {
        server.shutdown();
    }

    private void mirror(String module) {
        Map<Long, ChannelInfo> ch = new HashMap<>();
        ch.put(4L, new ChannelInfo("MS Chat", "chat"));
        settings.put(3, true, null, Collections.singletonList(
                new AccountView("cfg1", "Odoo exemple", LockScreenMode.ALWAYS, ch, module)));
    }

    private static String res(String name) throws Exception {
        try (InputStream in = ActionRunnerTest.class.getResourceAsStream("/chatpush/actions/" + name + ".json")) {
            byte[] buf = new byte[in.available()];
            int n = 0;
            while (n < buf.length) n += in.read(buf, n, buf.length - n);
            return new String(buf, StandardCharsets.UTF_8);
        }
    }

    private void answer(String name) throws Exception {
        server.enqueue(new MockResponse().setBody(res(name)));
    }

    private void status(int code) {
        server.enqueue(new MockResponse().setResponseCode(code));
    }

    /** The captured marker search, its rows' marker made the record's own; `rows` copies of the hit. */
    private void markerHits(String clientUuid, int rows) throws Exception {
        JSONObject one = new JSONObject(res("search_read_marker").replace(CAPTURED_UUID, clientUuid));
        JSONObject hit = one.getJSONArray("result").getJSONObject(0);
        JSONArray result = new JSONArray();
        for (int i = 0; i < rows; i++) result.put(new JSONObject(hit.toString()).put("id", 35 + i));
        one.put("result", result);
        server.enqueue(new MockResponse().setBody(one.toString()));
    }

    private List<RecordedRequest> requests() throws Exception {
        List<RecordedRequest> out = new ArrayList<>();
        RecordedRequest r;
        while ((r = server.takeRequest(10, java.util.concurrent.TimeUnit.MILLISECONDS)) != null) out.add(r);
        return out;
    }

    private static List<String> paths(List<RecordedRequest> rs) {
        List<String> out = new ArrayList<>();
        for (RecordedRequest r : rs) out.add(r.getPath());
        return out;
    }

    private static JSONObject paramsOf(RecordedRequest r) throws Exception {
        return new JSONObject(r.getBody().readUtf8()).getJSONObject("params");
    }

    private static int count(List<String> paths, String path) {
        int n = 0;
        for (String p : paths) if (p.equals(path)) n++;
        return n;
    }

    private static final String INFO = "/web/session/get_session_info";
    private static final String POST = "/mail/message/post";

    @Test
    public void aReplyWithTheModulePostsOnceAndIsDoneWithTheStoreAnswer() throws Exception {
        ChatAction a = store.add("cfg1", ActionKind.REPLY, 4, 0, 0, TEXT);
        answer("session_info");
        answer("post_answer");
        assertEquals(ActionRunner.Outcome.DONE, runner.run(a.id));
        List<RecordedRequest> rs = requests();
        assertEquals(List.of(INFO, POST), paths(rs));
        JSONObject p = paramsOf(rs.get(1));
        assertEquals(ReplyBody.of(TEXT, a.clientUuid), p.getJSONObject("post_data").getString("body"));
        assertEquals(a.clientUuid, p.getJSONObject("post_data").getString("erplibre_client_uuid"));
        assertEquals(a.clientUuid, p.getJSONObject("context").getString("temporary_id"));
        ChatAction back = store.get(a.id);
        assertEquals(ChatAction.State.DONE, back.state);
        assertEquals(now, back.sentAt);
        assertNotNull(back.answer);
        assertEquals(34, new JSONObject(back.answer).getJSONArray("mail.message").getJSONObject(0).getLong("id"));
        assertEquals(ActionRunner.Outcome.SKIPPED, runner.run(a.id));
        assertEquals(0, requests().size());
    }

    @Test
    public void aResendWithTheModulePostsAgainWithTheSameUuid() throws Exception {
        ChatAction a = store.add("cfg1", ActionKind.REPLY, 4, 0, 0, TEXT);
        answer("session_info");
        status(503);
        assertEquals(ActionRunner.Outcome.RETRY, runner.run(a.id));
        assertEquals(now + 30_000, store.get(a.id).nextAt);
        now += 30_000;
        answer("session_info");
        answer("post_answer_module_resend");
        assertEquals(ActionRunner.Outcome.DONE, runner.run(a.id));
        List<RecordedRequest> rs = requests();
        assertEquals(List.of(INFO, POST, INFO, POST), paths(rs));
        for (int i : new int[] {1, 3}) {
            JSONObject p = paramsOf(rs.get(i));
            assertEquals(a.clientUuid, p.getJSONObject("post_data").getString("erplibre_client_uuid"));
            assertEquals(a.clientUuid, p.getJSONObject("context").getString("temporary_id"));
        }
        assertEquals(34, new JSONObject(store.get(a.id).answer).getJSONArray("mail.message")
                .getJSONObject(0).getLong("id"));
    }

    @Test
    public void aLostAnswerWithoutModuleIsFoundByItsMarkerAfterTheQuietWindow() throws Exception {
        mirror("");
        ChatAction a = store.add("cfg1", ActionKind.REPLY, 4, 0, 0, TEXT);
        answer("session_info");
        // Odoo reads the whole post, then the answer never comes back
        server.enqueue(new MockResponse().setBody(res("post_answer_no_module_field"))
                .setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST));
        assertEquals(ActionRunner.Outcome.RETRY, runner.run(a.id));
        long sentAt = store.get(a.id).sentAt;
        assertEquals(now, sentAt);

        assertEquals(List.of(INFO, POST), paths(requests()));
        now += 30_000;
        // Inside the quiet window: back to wait without asking Odoo anything
        assertEquals(ActionRunner.Outcome.RETRY, runner.run(a.id));
        assertEquals(0, requests().size());
        assertEquals(sentAt + ActionStore.QUIET_MS, store.get(a.id).nextAt);
        now = sentAt + ActionStore.QUIET_MS - 1;
        assertTrue(store.due().isEmpty());

        now = sentAt + ActionStore.QUIET_MS;
        answer("session_info");
        markerHits(a.clientUuid, 1);
        assertEquals(ActionRunner.Outcome.DONE, runner.run(a.id));
        List<RecordedRequest> rs = requests();
        assertEquals(List.of(INFO, "/web/dataset/call_kw/mail.message/search_read"), paths(rs));
        JSONArray domain = paramsOf(rs.get(1)).getJSONArray("args").getJSONArray(0);
        assertEquals("[\"author_id\",\"=\",3]", domain.getJSONArray(2).toString());
        assertEquals(ChatAction.State.DONE, store.get(a.id).state);
    }

    @Test
    public void aReplyFirstSentWithoutTheModuleSearchesItsMarkerOnceTheModuleCame() throws Exception {
        mirror("");
        ChatAction a = store.add("cfg1", ActionKind.REPLY, 4, 0, 0, TEXT);
        answer("session_info");
        server.enqueue(new MockResponse().setBody(res("post_answer_no_module_field"))
                .setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST));
        assertEquals(ActionRunner.Outcome.RETRY, runner.run(a.id));
        assertTrue(store.get(a.id).plainSent);
        requests();

        mirror("1.5");
        now += 30_000;
        assertEquals(ActionRunner.Outcome.RETRY, runner.run(a.id));
        assertEquals(0, requests().size());
        now = store.get(a.id).nextAt;
        answer("session_info");
        markerHits(a.clientUuid, 1);
        assertEquals(ActionRunner.Outcome.DONE, runner.run(a.id));
        List<String> ps = paths(requests());
        assertEquals(List.of(INFO, "/web/dataset/call_kw/mail.message/search_read"), ps);
        assertEquals(0, count(ps, POST));
    }

    @Test
    public void aRunningActionCutByADeathResumesAsMaybeSent() throws Exception {
        mirror("");
        ChatAction a = store.add("cfg1", ActionKind.REPLY, 4, 0, 0, TEXT);
        // The process claims, stamps the send, and dies before the answer
        store.claim(a.id);
        store.markSent(a.id, true);
        long sentAt = now;

        now += 10_000;
        ActionStore next = new ActionStore(actionKv, box, () -> now, () -> "process-deux");
        ActionRunner again = new ActionRunner(next, sessions, settings, new OdooActions(new OkHttpClient()), () -> now);
        assertEquals(1, next.recover());
        assertEquals(ActionRunner.Outcome.RETRY, again.run(a.id));
        assertEquals(sentAt + ActionStore.QUIET_MS, next.get(a.id).nextAt);
        assertEquals(0, requests().size());

        now = sentAt + ActionStore.QUIET_MS;
        answer("session_info");
        markerHits(a.clientUuid, 0);
        answer("post_answer_no_module_field");
        assertEquals(ActionRunner.Outcome.DONE, again.run(a.id));
        List<RecordedRequest> rs = requests();
        assertEquals(List.of(INFO, "/web/dataset/call_kw/mail.message/search_read", POST), paths(rs));
        assertEquals(ReplyBody.of(TEXT, a.clientUuid), paramsOf(rs.get(2)).getJSONObject("post_data").getString("body"));
        assertEquals(now, next.get(a.id).sentAt);
    }

    @Test
    public void twoMarkerHitsHandOffAsAmbiguous() throws Exception {
        mirror("");
        ChatAction a = store.add("cfg1", ActionKind.REPLY, 4, 0, 0, TEXT);
        answer("session_info");
        status(502);
        assertEquals(ActionRunner.Outcome.RETRY, runner.run(a.id));
        now += ActionStore.QUIET_MS;
        answer("session_info");
        markerHits(a.clientUuid, 2);
        assertEquals(ActionRunner.Outcome.HANDOFF, runner.run(a.id));
        ChatAction back = store.get(a.id);
        assertEquals(ChatAction.State.HANDOFF, back.state);
        assertEquals("ambiguous", back.reason);
        assertTrue(back.sentAt > 0);
        assertEquals(1, count(paths(requests()), POST));
    }

    @Test
    public void anExpiredSessionHandsEveryKindOffAndMarksTheCopyExpired() throws Exception {
        for (ActionKind k : ActionKind.values()) {
            sessions.put(session);
            ChatAction a = store.add("cfg1", k, 4, k == ActionKind.REACT ? 32 : 0, 1_793_247_814L,
                    k == ActionKind.REPLY ? TEXT : "");
            answer("dead_session_info");
            assertEquals(k.name(), ActionRunner.Outcome.HANDOFF, runner.run(a.id));
            assertEquals(List.of(INFO), paths(requests()));
            assertTrue(sessions.expired("cfg1"));
            ChatAction back = store.get(a.id);
            assertEquals(ChatAction.State.HANDOFF, back.state);
            assertEquals("session_expired", back.reason);
            assertEquals(0L, back.sentAt);

            // The copy known dead: the next one goes to the app without a request
            ChatAction b = store.add("cfg1", k, 4, k == ActionKind.REACT ? 32 : 0, 1_793_247_814L,
                    k == ActionKind.REPLY ? TEXT : "");
            assertEquals(ActionRunner.Outcome.HANDOFF, runner.run(b.id));
            assertEquals(0, requests().size());
            assertEquals("session_expired", store.get(b.id).reason);
        }
        assertEquals(2 * ActionKind.values().length, store.handoffCount("cfg1"));

        sessions.forget("cfg1");
        ChatAction c = store.add("cfg1", ActionKind.MUTE, 4, 0, 0, "");
        assertEquals(ActionRunner.Outcome.HANDOFF, runner.run(c.id));
        assertEquals("session_expired", store.get(c.id).reason);
        assertEquals(0, requests().size());
    }

    @Test
    public void aJsonRpcNotFoundOnAnActionRouteRechecksTheSession() throws Exception {
        ChatAction a = store.add("cfg1", ActionKind.REACT, 4, 32, 0, "");
        answer("session_info");
        answer("dead_reaction");
        answer("dead_session_info");
        assertEquals(ActionRunner.Outcome.HANDOFF, runner.run(a.id));
        assertEquals(List.of(INFO, "/mail/message/reaction", INFO), paths(requests()));
        assertEquals("session_expired", store.get(a.id).reason);
        assertTrue(sessions.expired("cfg1"));

        sessions.put(session);
        ChatAction b = store.add("cfg1", ActionKind.REACT, 4, 32, 0, "");
        answer("session_info");
        answer("dead_reaction");
        answer("session_info");
        assertEquals(ActionRunner.Outcome.HANDOFF, runner.run(b.id));
        assertEquals("refused", store.get(b.id).reason);
        assertFalse(sessions.expired("cfg1"));
    }

    @Test
    public void markReadWithoutAMessageIdSearchesByDateThenMarks() throws Exception {
        ChatAction a = store.add("cfg1", ActionKind.READ, 4, 0, 1_793_247_814L, "");
        answer("session_info");
        answer("search_latest");
        answer("mark_as_read");
        answer("mark_all_as_read");
        assertEquals(ActionRunner.Outcome.DONE, runner.run(a.id));
        List<RecordedRequest> rs = requests();
        assertEquals(List.of(INFO, "/web/dataset/call_kw/mail.message/search", "/discuss/channel/mark_as_read",
                "/web/dataset/call_kw/mail.message/mark_all_as_read"), paths(rs));
        assertEquals("[\"date\",\"<=\",\"2026-10-29 04:23:34\"]",
                paramsOf(rs.get(1)).getJSONArray("args").getJSONArray(0).getJSONArray(2).toString());
        assertEquals(35, paramsOf(rs.get(2)).getLong("last_message_id"));
        assertEquals("[\"id\",\"<=\",35]",
                paramsOf(rs.get(3)).getJSONArray("args").getJSONArray(0).getJSONArray(2).toString());
        assertEquals(ChatAction.State.DONE, store.get(a.id).state);

        // Nothing dated before the bound: nothing to mark
        ChatAction b = store.add("cfg1", ActionKind.READ, 4, 0, 1_793_247_814L, "");
        answer("session_info");
        JSONObject none = new JSONObject(res("search_latest")).put("result", new JSONArray());
        server.enqueue(new MockResponse().setBody(none.toString()));
        assertEquals(ActionRunner.Outcome.DONE, runner.run(b.id));
        assertEquals(List.of(INFO, "/web/dataset/call_kw/mail.message/search"), paths(requests()));
    }

    @Test
    public void markReadWithAMessageIdDoesNotSearch() throws Exception {
        ChatAction a = store.add("cfg1", ActionKind.READ, 4, 32, 1_793_247_814L, "");
        answer("session_info");
        answer("mark_as_read");
        answer("mark_all_as_read");
        assertEquals(ActionRunner.Outcome.DONE, runner.run(a.id));
        List<RecordedRequest> rs = requests();
        assertEquals(List.of(INFO, "/discuss/channel/mark_as_read",
                "/web/dataset/call_kw/mail.message/mark_all_as_read"), paths(rs));
        assertEquals(32, paramsOf(rs.get(1)).getLong("last_message_id"));
    }

    @Test
    public void aMuteRetriedLaterSendsTheMinutesLeft() throws Exception {
        ChatAction a = store.add("cfg1", ActionKind.MUTE, 4, 0, 0, "");
        answer("session_info");
        status(503);
        assertEquals(ActionRunner.Outcome.RETRY, runner.run(a.id));
        now += 20 * 60_000L;
        answer("session_info");
        answer("mute");
        assertEquals(ActionRunner.Outcome.DONE, runner.run(a.id));
        List<RecordedRequest> rs = requests();
        assertEquals(List.of(INFO, "/discuss/settings/mute", INFO, "/discuss/settings/mute"), paths(rs));
        assertEquals(60, paramsOf(rs.get(1)).getInt("minutes"));
        JSONObject second = paramsOf(rs.get(3));
        assertEquals(40, second.getInt("minutes"));
        assertEquals(4, second.getLong("channel_id"));
    }

    @Test
    public void aMuteWhoseHourPassedIsDoneWithoutACall() throws Exception {
        ChatAction a = store.add("cfg1", ActionKind.MUTE, 4, 0, 0, "");
        now += HOUR;
        assertEquals(ActionRunner.Outcome.DONE, runner.run(a.id));
        assertEquals(0, requests().size());
        assertEquals(ChatAction.State.DONE, store.get(a.id).state);
        assertNull(store.get(a.id).answer);
    }

    @Test
    public void reactSendsTheMessageId() throws Exception {
        ChatAction a = store.add("cfg1", ActionKind.REACT, 4, 32, 0, "");
        answer("session_info");
        answer("reaction_add");
        assertEquals(ActionRunner.Outcome.DONE, runner.run(a.id));
        List<RecordedRequest> rs = requests();
        assertEquals(List.of(INFO, "/mail/message/reaction"), paths(rs));
        JSONObject p = paramsOf(rs.get(1));
        assertEquals(32, p.getLong("message_id"));
        assertEquals("👍", p.getString("content"));
        assertEquals("add", p.getString("action"));
        String answer = store.get(a.id).answer;
        assertEquals(32, new JSONObject(answer).getJSONArray("MessageReactions").getJSONObject(0).getLong("message"));
    }

    @Test
    public void a403HandsOffAsRefused() throws Exception {
        ChatAction a = store.add("cfg1", ActionKind.REPLY, 4, 0, 0, TEXT);
        answer("session_info");
        status(403);
        assertEquals(ActionRunner.Outcome.HANDOFF, runner.run(a.id));
        assertEquals("refused", store.get(a.id).reason);
        assertEquals(1, store.forDrain().size());
    }

    @Test
    public void anActionFailingForADayHandsOffAsStale() throws Exception {
        ChatAction a = store.add("cfg1", ActionKind.READ, 4, 32, 0, "");
        ActionRunner.Outcome o;
        int runs = 0;
        while (true) {
            answer("session_info");
            status(503);
            o = runner.run(a.id);
            assertEquals(List.of(INFO, "/discuss/channel/mark_as_read"), paths(requests()));
            runs++;
            if (o != ActionRunner.Outcome.RETRY) break;
            assertTrue(now - a.createdAt < ActionStore.STALE_MS);
            now = store.get(a.id).nextAt;
        }
        assertEquals(ActionRunner.Outcome.HANDOFF, o);
        assertTrue(now - a.createdAt >= ActionStore.STALE_MS);
        assertEquals("stale", store.get(a.id).reason);
        assertTrue(runs > 20 && runs < 40);
    }

    @Test
    public void anAccountNoLongerMirroredDropsItsAction() throws Exception {
        ChatAction a = store.add("cfg1", ActionKind.REPLY, 4, 0, 0, TEXT);
        settings.put(3, true, null, Collections.<AccountView>emptyList());
        assertEquals(ActionRunner.Outcome.DONE, runner.run(a.id));
        assertEquals(0, requests().size());
        ChatAction back = store.get(a.id);
        assertEquals(ChatAction.State.DONE, back.state);
        assertNull(back.answer);
        assertEquals(1, store.forDrain().size());
    }

    @Test
    public void runDueRunsOnlyDueRecordsOldestFirst() throws Exception {
        ChatAction later = store.add("cfg1", ActionKind.MUTE, 5, 0, 0, "");
        answer("session_info");
        status(503);
        assertEquals(ActionRunner.Outcome.RETRY, runner.run(later.id));
        requests();
        now += 1_000;
        ChatAction oldest = store.add("cfg1", ActionKind.MUTE, 6, 0, 0, "");
        now += 1_000;
        ChatAction newest = store.add("cfg1", ActionKind.MUTE, 7, 0, 0, "");
        now += 1_000;
        for (int i = 0; i < 2; i++) {
            answer("session_info");
            answer("mute");
        }
        Map<String, ActionRunner.Outcome> out = runner.runDue();
        assertEquals(Arrays.asList(oldest.id, newest.id), new ArrayList<>(out.keySet()));
        assertEquals(Arrays.asList(ActionRunner.Outcome.DONE, ActionRunner.Outcome.DONE),
                new ArrayList<>(out.values()));
        List<RecordedRequest> rs = requests();
        assertEquals(4, rs.size());
        assertEquals(6, paramsOf(rs.get(1)).getLong("channel_id"));
        assertEquals(7, paramsOf(rs.get(3)).getLong("channel_id"));
        assertEquals(ChatAction.State.DONE, store.get(oldest.id).state);
        assertEquals(ChatAction.State.DONE, store.get(newest.id).state);
        assertEquals(ChatAction.State.PENDING, store.get(later.id).state);
    }
}
