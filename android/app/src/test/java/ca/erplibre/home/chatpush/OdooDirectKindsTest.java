package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.Locale;
import okhttp3.OkHttpClient;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import org.junit.Test;

/** The lot 1 checks keep lot 1's reason vocabulary whatever kind the shared client raises. */
public class OdooDirectKindsTest {

    private static final PushStrings FR = new PushStrings(null);

    @Test
    public void noKindCanLeakARawReasonKeyIntoAStatusOrAHealthText() {
        for (OdooDirectException.Kind raw : OdooDirectException.Kind.values()) {
            OdooDirectException.Kind k = PushEngine.checkKind(raw);
            String status = PushEngine.odooReasonKey(k.name());
            assertNotEquals(raw + " status", status, FR.get(status));
            String health = "reason_" + k.name().toLowerCase(Locale.ROOT);
            assertNotEquals(raw + " health", health, FR.get(health));
        }
        assertEquals(OdooDirectException.Kind.PROTOCOL, PushEngine.checkKind(OdooDirectException.Kind.REFUSED));
        assertEquals(OdooDirectException.Kind.PROTOCOL, PushEngine.checkKind(OdooDirectException.Kind.NOT_FOUND));
        assertEquals(OdooDirectException.Kind.UNREACHABLE, PushEngine.checkKind(OdooDirectException.Kind.TRANSIENT));
    }

    @Test
    public void unregisterTreatsOnlyAnHttpNotFoundAsGone() throws Exception {
        MockWebServer server = new MockWebServer();
        server.start();
        try {
            OdooDirect odoo = new OdooDirect(new OkHttpClient());
            NativeSession s = new NativeSession("cfg1", server.url("/").toString(), "exemple_db", "sid_exemple_secret", 1L);
            server.enqueue(new MockResponse().setResponseCode(404));
            try {
                odoo.unregister(s, "https://ntfy.exemple.test/upab12cd34topic", true);
                fail();
            } catch (OdooDirectException e) {
                assertEquals(OdooDirectException.Kind.NOT_FOUND, e.kind());
                assertFalse(e.rpc());
            }
            server.enqueue(new MockResponse().setBody("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":404,"
                    + "\"message\":\"404: Not Found\"}}"));
            try {
                odoo.unregister(s, "https://ntfy.exemple.test/upab12cd34topic", true);
                fail();
            } catch (OdooDirectException e) {
                assertEquals(OdooDirectException.Kind.PROTOCOL, e.kind());
            }
        } finally {
            server.shutdown();
        }
    }

    @Test
    public void aJsonRpcErrorIsMarkedRpcAndAnHttpStatusIsNot() throws Exception {
        MockWebServer server = new MockWebServer();
        server.start();
        try {
            OdooJson json = new OdooJson(new OkHttpClient());
            NativeSession s = new NativeSession("cfg1", server.url("/").toString(), "exemple_db", "sid_exemple_secret", 1L);
            String[] bodies = {"{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":404}}",
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":100}}",
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":200}}"};
            for (String b : bodies) {
                server.enqueue(new MockResponse().setBody(b));
                try {
                    json.call(s, "/x", new org.json.JSONObject(), true);
                    fail();
                } catch (OdooDirectException e) {
                    assertTrue(e.rpc());
                }
            }
            for (int code : new int[] {401, 404, 403, 503}) {
                server.enqueue(new MockResponse().setResponseCode(code));
                try {
                    json.call(s, "/x", new org.json.JSONObject(), true);
                    fail();
                } catch (OdooDirectException e) {
                    assertFalse(e.rpc());
                }
            }
        } finally {
            server.shutdown();
        }
    }
}
