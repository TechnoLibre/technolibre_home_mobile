package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import okhttp3.OkHttpClient;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public class OdooDirectTest {

    private static final long NOW = 1704067200000L;

    private MockWebServer server;
    private OdooDirect odoo;
    private NativeSession session;

    @Before
    public void setUp() throws Exception {
        server = new MockWebServer();
        server.start();
        odoo = new OdooDirect(new OkHttpClient());
        session = new NativeSession("cfg1", server.url("/").toString(), "db_exemple", "sid_exemple_secret", 1L);
    }

    @After
    public void tearDown() throws Exception {
        server.shutdown();
    }

    private static String mailData() throws Exception {
        try (InputStream in = OdooDirectTest.class.getResourceAsStream("/chatpush/mail_data_counters.json")) {
            byte[] buf = new byte[in.available()];
            int n = 0;
            while (n < buf.length) n += in.read(buf, n, buf.length - n);
            return new String(buf, StandardCharsets.UTF_8);
        }
    }

    private static MockResponse rpc(String result) {
        return new MockResponse().setBody("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":" + result + "}");
    }

    @Test
    public void checkReadsSessionInfoThenMailDataWithTheSessionCookie() throws Exception {
        server.enqueue(rpc("{\"storeData\":{\"Store\":{\"settings\":{\"mute_until_dt\":false}}}}"));
        server.enqueue(rpc(mailData()));
        UnreadSummary s = odoo.check(session, true, NOW);
        assertEquals(12, s.total);
        RecordedRequest info = server.takeRequest();
        RecordedRequest data = server.takeRequest();
        assertEquals("/web/session/get_session_info", info.getPath());
        assertEquals("/mail/data", data.getPath());
        assertEquals("session_id=sid_exemple_secret", data.getHeader("Cookie"));
        JSONObject params = new JSONObject(data.getBody().readUtf8()).getJSONObject("params");
        assertTrue(params.getBoolean("channels_as_member"));
        assertTrue(params.has("init_messaging"));
    }

    /**
     * /mail/data as Odoo 18 answers it: neither its Store nor its channels
     * name the self partner or member (no self, no selfMember); the
     * session info does.
     */
    private static String mailDataWithoutSelf() throws Exception {
        JSONObject d = new JSONObject(mailData());
        d.getJSONObject("Store").remove("self");
        org.json.JSONArray channels = d.getJSONArray("discuss.channel");
        for (int i = 0; i < channels.length(); i++) channels.getJSONObject(i).remove("selfMember");
        return d.toString();
    }

    @Test
    public void theSelfPartnerComesFromTheSessionInfoStore() throws Exception {
        server.enqueue(rpc("{\"partner_id\":99,\"storeData\":{\"Store\":{\"self\":{\"id\":7,\"type\":\"partner\"},"
                + "\"settings\":{\"mute_until_dt\":false}}}}"));
        server.enqueue(rpc(mailDataWithoutSelf()));
        assertEquals(12, odoo.check(session, true, NOW).total);
    }

    @Test
    public void theSelfPartnerFallsBackToTheSessionPartnerId() throws Exception {
        server.enqueue(rpc("{\"partner_id\":7}"));
        server.enqueue(rpc(mailDataWithoutSelf()));
        assertEquals(12, odoo.check(session, true, NOW).total);
    }

    @Test
    public void theGlobalMuteOfSessionInfoSilencesTheCount() throws Exception {
        server.enqueue(rpc("{\"storeData\":{\"Store\":{\"settings\":{\"mute_until_dt\":\"9999-12-31 23:59:59\"}}}}"));
        server.enqueue(rpc(mailData()));
        assertEquals(2, odoo.check(session, true, NOW).total);
    }

    @Test
    public void checkNeverCallsARouteThatMarksRead() throws Exception {
        server.enqueue(rpc("{}"));
        server.enqueue(rpc(mailData()));
        odoo.check(session, true, NOW);
        List<String> paths = new ArrayList<>();
        paths.add(server.takeRequest().getPath());
        paths.add(server.takeRequest().getPath());
        assertEquals(2, server.getRequestCount());
        assertEquals("[/web/session/get_session_info, /mail/data]", paths.toString());
    }

    @Test
    public void code100IsSessionExpired() throws Exception {
        server.enqueue(new MockResponse().setBody(
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":100,\"message\":\"Odoo Session Expired\"}}"));
        try {
            odoo.check(session, true, NOW);
            fail();
        } catch (OdooDirectException e) {
            assertEquals(OdooDirectException.Kind.SESSION_EXPIRED, e.kind());
            assertFalse(e.getMessage().contains("sid_exemple_secret"));
        }
    }

    @Test
    public void http401IsSessionExpired() throws Exception {
        server.enqueue(new MockResponse().setResponseCode(401));
        try {
            odoo.check(session, true, NOW);
            fail();
        } catch (OdooDirectException e) {
            assertEquals(OdooDirectException.Kind.SESSION_EXPIRED, e.kind());
        }
    }

    @Test
    public void aRedirectIsNotFollowed() throws Exception {
        server.enqueue(new MockResponse().setResponseCode(303).setHeader("Location", "/web/login"));
        try {
            odoo.check(session, true, NOW);
            fail();
        } catch (OdooDirectException e) {
            assertEquals(OdooDirectException.Kind.PROTOCOL, e.kind());
        }
        assertEquals(1, server.getRequestCount());
    }

    @Test
    public void httpRefusedBeforeAnyRequest() throws Exception {
        try {
            odoo.check(session, false, NOW);
            fail();
        } catch (OdooDirectException e) {
            assertEquals(OdooDirectException.Kind.HTTP_REFUSED, e.kind());
        }
        assertEquals(0, server.getRequestCount());
    }

    @Test
    public void unregisterSendsTheEndpointToUnregisterDevices() throws Exception {
        server.enqueue(rpc("null"));
        odoo.unregister(session, "http://ntfy.exemple.test/upab12cd34topic", true);
        RecordedRequest r = server.takeRequest();
        assertEquals("/web/dataset/call_kw/mail.push.device/unregister_devices", r.getPath());
        assertEquals("session_id=sid_exemple_secret", r.getHeader("Cookie"));
        JSONObject p = new JSONObject(r.getBody().readUtf8()).getJSONObject("params");
        assertEquals("mail.push.device", p.getString("model"));
        assertEquals("unregister_devices", p.getString("method"));
        assertEquals("http://ntfy.exemple.test/upab12cd34topic", p.getJSONObject("kwargs").getString("endpoint"));
    }

    @Test
    public void a404Or410IsNotFound() throws Exception {
        for (int code : new int[] {404, 410}) {
            server.enqueue(new MockResponse().setResponseCode(code));
            try {
                odoo.unregister(session, "https://ntfy.exemple.test/upab12cd34topic", true);
                fail();
            } catch (OdooDirectException e) {
                assertEquals(OdooDirectException.Kind.NOT_FOUND, e.kind());
            }
        }
    }

    @Test
    public void aBodyThatIsNotJsonIsProtocol() throws Exception {
        server.enqueue(new MockResponse().setBody("<html>login</html>"));
        try {
            odoo.check(session, true, NOW);
            fail();
        } catch (OdooDirectException e) {
            assertEquals(OdooDirectException.Kind.PROTOCOL, e.kind());
        }
    }

    @Test
    public void aPlatformCleartextRefusalIsCleartextBlocked() throws Exception {
        OkHttpClient refusing = new OkHttpClient.Builder().addInterceptor(chain -> {
            throw new java.net.UnknownServiceException("CLEARTEXT communication not permitted");
        }).build();
        try {
            new OdooDirect(refusing).check(session, true, NOW);
            fail();
        } catch (OdooDirectException e) {
            assertEquals(OdooDirectException.Kind.CLEARTEXT_BLOCKED, e.kind());
        }
    }
}
