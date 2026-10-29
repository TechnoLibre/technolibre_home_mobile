package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import okhttp3.OkHttpClient;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** The action client against the answers Odoo 18 really gave (resources chatpush/actions). */
public class OdooActionsTest {

    private static final String MODULE_UUID = "03b81044-5d6f-4256-9671-773a54cfe4d3";
    private static final String PLAIN_UUID = "24ff0bf7-76b8-4caf-ad92-a71df8436306";
    private static final String SID = "sid_exemple_secret";

    private MockWebServer server;
    private OdooActions actions;
    private NativeSession session;

    @Before
    public void setUp() throws Exception {
        server = new MockWebServer();
        server.start();
        actions = new OdooActions(new OkHttpClient());
        session = new NativeSession("cfg1", server.url("/").toString(), "exemple_db", SID, 1L);
    }

    @After
    public void tearDown() throws Exception {
        server.shutdown();
    }

    private static String res(String name) throws Exception {
        try (InputStream in = OdooActionsTest.class.getResourceAsStream("/chatpush/actions/" + name + ".json")) {
            byte[] buf = new byte[in.available()];
            int n = 0;
            while (n < buf.length) n += in.read(buf, n, buf.length - n);
            return new String(buf, StandardCharsets.UTF_8);
        }
    }

    private void answer(String name) throws Exception {
        server.enqueue(new MockResponse().setBody(res(name)));
    }

    private static JSONObject paramsOf(RecordedRequest r) throws Exception {
        return new JSONObject(r.getBody().readUtf8()).getJSONObject("params");
    }

    private OdooDirectException.Kind failureOf(Runnable0 call) {
        try {
            call.run();
        } catch (OdooDirectException e) {
            return e.kind();
        } catch (Exception e) {
            fail("unexpected " + e);
        }
        fail("no failure");
        return null;
    }

    private interface Runnable0 {
        void run() throws Exception;
    }

    @Test
    public void aliveReturnsTheSelfPartner() throws Exception {
        answer("session_info");
        assertEquals(3L, actions.alive(session, true));
        RecordedRequest r = server.takeRequest();
        assertEquals("/web/session/get_session_info", r.getPath());
        assertEquals("session_id=" + SID, r.getHeader("Cookie"));
    }

    @Test
    public void aDeadSessionIsSessionExpiredBeforeAnyActionRoute() throws Exception {
        answer("dead_session_info");
        assertEquals(OdooDirectException.Kind.SESSION_EXPIRED, failureOf(() -> actions.alive(session, true)));
        assertEquals(1, server.getRequestCount());
        server.enqueue(new MockResponse().setResponseCode(401));
        assertEquals(OdooDirectException.Kind.SESSION_EXPIRED, failureOf(() -> actions.alive(session, true)));
        assertEquals(2, server.getRequestCount());
    }

    @Test
    public void postSendsTheMarkerTheTemporaryIdAndTheUuidWithTheModule() throws Exception {
        answer("post_answer");
        String body = ReplyBody.of("Bonjour du test d'action", MODULE_UUID);
        Posted p = actions.post(session, 4, body, MODULE_UUID, true, true);
        assertEquals(34L, p.messageId);
        assertNotNull(p.answer);
        assertTrue(p.answer.contains("\"mail.message\""));
        RecordedRequest r = server.takeRequest();
        assertEquals("/mail/message/post", r.getPath());
        JSONObject params = paramsOf(r);
        assertEquals("discuss.channel", params.getString("thread_model"));
        assertEquals(4, params.getInt("thread_id"));
        JSONObject data = params.getJSONObject("post_data");
        assertEquals(body, data.getString("body"));
        assertTrue(data.getString("body").endsWith("<!-- erplibre-mobile:" + MODULE_UUID + " -->"));
        assertEquals("comment", data.getString("message_type"));
        assertEquals("mail.mt_comment", data.getString("subtype_xmlid"));
        assertEquals(MODULE_UUID, data.getString("erplibre_client_uuid"));
        assertEquals(MODULE_UUID, params.getJSONObject("context").getString("temporary_id"));
    }

    @Test
    public void aResendWithTheModuleGetsTheFirstMessage() throws Exception {
        answer("post_answer");
        answer("post_answer_module_resend");
        String body = ReplyBody.of("Bonjour du test d'action", MODULE_UUID);
        long first = actions.post(session, 4, body, MODULE_UUID, true, true).messageId;
        long again = actions.post(session, 4, body, MODULE_UUID, true, true).messageId;
        assertEquals(first, again);
    }

    @Test
    public void postWithoutTheModuleSendsNoUuidField() throws Exception {
        answer("post_answer_no_module_field");
        Posted p = actions.post(session, 4, ReplyBody.of("x", PLAIN_UUID), PLAIN_UUID, false, true);
        assertEquals(35L, p.messageId);
        JSONObject params = paramsOf(server.takeRequest());
        assertFalse(params.getJSONObject("post_data").has("erplibre_client_uuid"));
        assertEquals(PLAIN_UUID, params.getJSONObject("context").getString("temporary_id"));
    }

    @Test
    public void aPostAnswerWithoutAnIdIsTransient() throws Exception {
        server.enqueue(new MockResponse().setBody("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"mail.message\":[]}}"));
        assertEquals(OdooDirectException.Kind.TRANSIENT,
                failureOf(() -> actions.post(session, 4, "x", PLAIN_UUID, false, true)));
        server.enqueue(new MockResponse().setBody("{\"jsonrpc\":\"2.0\",\"id\":1}"));
        assertEquals(OdooDirectException.Kind.TRANSIENT,
                failureOf(() -> actions.post(session, 4, "x", PLAIN_UUID, false, true)));
    }

    @Test
    public void aBigPostAnswerIsNotKept() throws Exception {
        StringBuilder big = new StringBuilder(40000);
        for (int i = 0; i < 40000; i++) big.append('a');
        server.enqueue(new MockResponse().setBody("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"mail.message\":[{\"id\":9,"
                + "\"body\":\"" + big + "\"}]}}"));
        Posted p = actions.post(session, 4, "x", PLAIN_UUID, false, true);
        assertEquals(9L, p.messageId);
        assertNull(p.answer);
    }

    @Test
    public void aPostWhoseAnswerIsLostIsNeverReplayed() throws Exception {
        // alive first, so the post reuses the pooled connection as the runner's does
        answer("session_info");
        actions.alive(session, true);
        server.enqueue(new MockResponse().setResponseCode(408));
        assertEquals(OdooDirectException.Kind.TRANSIENT,
                failureOf(() -> actions.post(session, 4, "x", PLAIN_UUID, false, true)));
        assertEquals(2, server.getRequestCount());
        server.enqueue(new MockResponse().setBody(res("post_answer_no_module_field"))
                .setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AFTER_REQUEST));
        // What a replay would get
        answer("post_answer_no_module_field");
        assertEquals(OdooDirectException.Kind.UNREACHABLE,
                failureOf(() -> actions.post(session, 4, "x", PLAIN_UUID, false, true)));
        assertEquals(3, server.getRequestCount());
    }

    @Test
    public void aDeadPostIsNotFound() throws Exception {
        answer("dead_post");
        assertEquals(OdooDirectException.Kind.NOT_FOUND,
                failureOf(() -> actions.post(session, 4, "x", PLAIN_UUID, false, true)));
    }

    @Test
    public void findSentFiltersOnTheWholeMarkerComment() throws Exception {
        answer("search_read_marker");
        Long id = actions.findSent(session, 4, PLAIN_UUID, 3L, true);
        assertEquals(Long.valueOf(35), id);
        RecordedRequest r = server.takeRequest();
        assertEquals("/web/dataset/call_kw/mail.message/search_read", r.getPath());
        JSONObject params = paramsOf(r);
        assertEquals("mail.message", params.getString("model"));
        assertEquals("search_read", params.getString("method"));
        JSONArray domain = params.getJSONArray("args").getJSONArray(0);
        assertEquals("[[\"model\",\"=\",\"discuss.channel\"],[\"res_id\",\"=\",4],[\"author_id\",\"=\",3],"
                + "[\"body\",\"ilike\",\"erplibre-mobile:" + PLAIN_UUID + "\"]]", domain.toString());
        assertEquals(2, params.getJSONObject("kwargs").getInt("limit"));

        String quoted = res("search_read_marker").replace("<!-- erplibre-mobile:" + PLAIN_UUID + " -->",
                "erplibre-mobile:" + PLAIN_UUID);
        server.enqueue(new MockResponse().setBody(quoted));
        assertNull(actions.findSent(session, 4, PLAIN_UUID, 3L, true));
    }

    @Test
    public void findSentWithTwoHitsIsAmbiguous() throws Exception {
        JSONObject one = new JSONObject(res("search_read_marker"));
        JSONObject other = new JSONObject(one.getJSONArray("result").getJSONObject(0).toString()).put("id", 36);
        one.getJSONArray("result").put(other);
        server.enqueue(new MockResponse().setBody(one.toString()));
        assertEquals(OdooDirectException.Kind.AMBIGUOUS,
                failureOf(() -> actions.findSent(session, 4, PLAIN_UUID, 3L, true)));
    }

    @Test
    public void latestMessageIdUsesSearchWithTheDateBoundNeverAFetchRoute() throws Exception {
        answer("search_latest");
        Long id = actions.latestMessageId(session, 4, 1793247814L, true);
        assertEquals(Long.valueOf(35), id);
        assertEquals(1, server.getRequestCount());
        RecordedRequest r = server.takeRequest();
        assertEquals("/web/dataset/call_kw/mail.message/search", r.getPath());
        JSONObject params = paramsOf(r);
        assertEquals("[[\"model\",\"=\",\"discuss.channel\"],[\"res_id\",\"=\",4],"
                + "[\"date\",\"<=\",\"2026-10-29 04:23:34\"]]", params.getJSONArray("args").getJSONArray(0).toString());
        assertEquals("id desc", params.getJSONObject("kwargs").getString("order"));
        assertEquals(1, params.getJSONObject("kwargs").getInt("limit"));

        server.enqueue(new MockResponse().setBody("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":[]}"));
        assertNull(actions.latestMessageId(session, 4, 1793247814L, true));
    }

    @Test
    public void markReadBoundsMarkAllAsReadToTheChannelAndTheId() throws Exception {
        answer("mark_as_read");
        answer("mark_all_as_read");
        actions.markRead(session, 4, 35, true);
        RecordedRequest first = server.takeRequest();
        assertEquals("/discuss/channel/mark_as_read", first.getPath());
        JSONObject p1 = paramsOf(first);
        assertEquals(4, p1.getInt("channel_id"));
        assertEquals(35, p1.getInt("last_message_id"));
        RecordedRequest second = server.takeRequest();
        assertEquals("/web/dataset/call_kw/mail.message/mark_all_as_read", second.getPath());
        JSONObject p2 = paramsOf(second);
        assertEquals("mark_all_as_read", p2.getString("method"));
        assertEquals("[[\"model\",\"=\",\"discuss.channel\"],[\"res_id\",\"=\",4],[\"id\",\"<=\",35]]",
                p2.getJSONArray("args").getJSONArray(0).toString());
    }

    @Test
    public void aLiveAnswerWithoutAResultKeyIsSuccess() throws Exception {
        answer("mark_as_read");
        answer("mark_all_as_read");
        actions.markRead(session, 4, 35, true);
        answer("mute");
        actions.mute(session, 4, 60, true);
        server.enqueue(new MockResponse().setBody("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":null}"));
        actions.mute(session, 4, 60, true);
    }

    @Test
    public void muteSendsTheMinutesAndTheChannel() throws Exception {
        answer("mute");
        actions.mute(session, 4, 60, true);
        RecordedRequest r = server.takeRequest();
        assertEquals("/discuss/settings/mute", r.getPath());
        JSONObject p = paramsOf(r);
        assertEquals(60, p.getInt("minutes"));
        assertEquals(4, p.getInt("channel_id"));
    }

    @Test
    public void reactAddsAndReturnsTheStoreAnswer() throws Exception {
        answer("reaction_add");
        String store = actions.react(session, 32, "👍", true);
        RecordedRequest r = server.takeRequest();
        assertEquals("/mail/message/reaction", r.getPath());
        JSONObject p = paramsOf(r);
        assertEquals(32, p.getInt("message_id"));
        assertEquals("👍", p.getString("content"));
        assertEquals("add", p.getString("action"));
        JSONObject parsed = new JSONObject(store);
        assertEquals(32, parsed.getJSONArray("MessageReactions").getJSONObject(0).getInt("message"));
        answer("reaction_add_again");
        assertEquals(store, actions.react(session, 32, "👍", true));
    }

    @Test
    public void aDeadReactionIsNotFound() throws Exception {
        answer("dead_reaction");
        assertEquals(OdooDirectException.Kind.NOT_FOUND,
                failureOf(() -> actions.react(session, 32, "👍", true)));
    }

    @Test
    public void httpIsRefusedBeforeAnyRequest() throws Exception {
        NativeSession plain = new NativeSession("cfg1", "http://odoo.exemple.test", "exemple_db", SID, 1L);
        assertEquals(OdooDirectException.Kind.HTTP_REFUSED, failureOf(() -> actions.alive(plain, false)));
        assertEquals(OdooDirectException.Kind.HTTP_REFUSED,
                failureOf(() -> actions.mute(plain, 4, 60, false)));
        assertEquals(0, server.getRequestCount());
    }

    @Test
    public void a503IsTransientAnd403Refused() throws Exception {
        for (int code : new int[] {408, 429, 500, 503}) {
            server.enqueue(new MockResponse().setResponseCode(code));
            assertEquals(OdooDirectException.Kind.TRANSIENT, failureOf(() -> actions.mute(session, 4, 5, true)));
        }
        for (int code : new int[] {400, 403}) {
            server.enqueue(new MockResponse().setResponseCode(code));
            assertEquals(OdooDirectException.Kind.REFUSED, failureOf(() -> actions.mute(session, 4, 5, true)));
        }
        server.enqueue(new MockResponse().setResponseCode(404));
        assertEquals(OdooDirectException.Kind.NOT_FOUND, failureOf(() -> actions.mute(session, 4, 5, true)));
        server.enqueue(new MockResponse().setBody("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":200,"
                + "\"message\":\"Odoo Server Error\"}}"));
        assertEquals(OdooDirectException.Kind.REFUSED, failureOf(() -> actions.mute(session, 4, 5, true)));
    }

    @Test
    public void noExceptionMessageCarriesTheSessionIdOrAUrl() throws Exception {
        String host = server.getHostName();
        int[] codes = {401, 403, 404, 429, 503, 303};
        for (int code : codes) {
            server.enqueue(new MockResponse().setResponseCode(code).setHeader("Location", "/web/login"));
            checkMessage(host);
        }
        answer("dead_session_info");
        checkMessage(host);
        answer("dead_post");
        checkMessage(host);
        server.enqueue(new MockResponse().setBody("<html>" + SID + "</html>"));
        checkMessage(host);
        server.shutdown();
        checkMessage(host);
    }

    private void checkMessage(String host) {
        try {
            actions.mute(session, 4, 5, true);
            fail("no failure");
        } catch (OdooDirectException e) {
            String m = String.valueOf(e.getMessage());
            assertFalse(m, m.contains(SID));
            assertFalse(m, m.contains("http"));
            assertFalse(m, m.contains(host));
            assertFalse(m, m.contains("/mail") || m.contains("/discuss"));
        }
    }
}
