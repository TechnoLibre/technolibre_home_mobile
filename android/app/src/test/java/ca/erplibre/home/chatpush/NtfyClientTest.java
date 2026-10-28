package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.net.ServerSocket;
import java.net.UnknownServiceException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.OkHttpClient;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public class NtfyClientTest {

    private static final String TOKEN = "tk_abcdefghijklmnopqrstuvwxyz012";

    private MockWebServer server;
    private NtfyServer ntfy;
    private NtfyClient client;

    @Before
    public void setUp() throws IOException {
        server = new MockWebServer();
        server.start();
        ntfy = new NtfyServer(server.url("/").toString(), TOKEN, "upab12cd34", 43200);
        client = new NtfyClient(new OkHttpClient());
    }

    @After
    public void tearDown() throws IOException {
        server.shutdown();
    }

    /** Events as the listener saw them, in order, plus the close cause. */
    private static final class Recorder implements NtfyClient.Listener {
        final List<String> events = new java.util.concurrent.CopyOnWriteArrayList<>();
        final java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
        final BlockingQueue<NtfyMessage> messages = new LinkedBlockingQueue<>();
        final BlockingQueue<NtfyException> closed = new LinkedBlockingQueue<>();
        volatile boolean cleanClose;

        public void onOpen() { events.add("open"); }
        public void onMessage(NtfyMessage m) { events.add("message:" + m.id); messages.add(m); }
        public void onKeepalive() { events.add("keepalive"); }
        public void onClosed(NtfyException cause) {
            if (cause == null) cleanClose = true;
            else closed.add(cause);
            events.add("closed");
            done.countDown();
        }
    }

    private static String event(String id, String event, String message, boolean base64) {
        return "{\"id\":\"" + id + "\",\"time\":1790000000,\"expires\":1790043200,\"event\":\"" + event
                + "\",\"topic\":\"upab12cd34xx\""
                + (message == null ? "" : ",\"message\":\"" + message + "\"")
                + (base64 ? ",\"encoding\":\"base64\"" : "") + "}\n";
    }

    private static List<String> topics(String... t) {
        return Arrays.asList(t);
    }

    @Test
    public void streamSendsTheBearerTokenAndTheSinceCursor() throws Exception {
        server.enqueue(new MockResponse().setBody(event("o1", "open", null, false)));
        Recorder r = new Recorder();
        client.stream(ntfy, topics("upab12cd34aa", "upab12cd34bb"), "Qw3rTy9uIo12", true, r);
        waitFor(r);
        RecordedRequest req = server.takeRequest(5, TimeUnit.SECONDS);
        assertEquals("Bearer " + TOKEN, req.getHeader("Authorization"));
        assertEquals("/upab12cd34aa,upab12cd34bb/json?since=Qw3rTy9uIo12", req.getPath());
        assertEquals("GET", req.getMethod());
    }

    @Test
    public void streamDeliversOpenKeepaliveAndMessageEventsInOrder() throws Exception {
        server.enqueue(new MockResponse().setBody(event("o1", "open", null, false)
                + event("k1", "keepalive", null, false)
                + event("m1", "message", "hello", false)
                + event("m2", "message", "world", false)));
        Recorder r = new Recorder();
        client.stream(ntfy, topics("upab12cd34aa"), "all", true, r);
        waitFor(r);
        assertEquals(Arrays.asList("open", "keepalive", "message:m1", "message:m2", "closed"),
                new ArrayList<>(r.events));
        assertTrue(r.cleanClose);
    }

    @Test
    public void base64BodyIsDecodedAndRawBodyTakenAsUtf8() throws Exception {
        byte[] bin = {0, 1, (byte) 0xfe, (byte) 0xff, 42};
        server.enqueue(new MockResponse().setBody(
                event("m1", "message", B64.encode(bin, false), true)
                        + event("m2", "message", "caf\\u00e9", false)));
        Recorder r = new Recorder();
        client.stream(ntfy, topics("upab12cd34aa"), "all", true, r);
        waitFor(r);
        assertArrayEquals(bin, r.messages.take().body);
        assertArrayEquals("café".getBytes(StandardCharsets.UTF_8), r.messages.take().body);
    }

    @Test
    public void pollAlwaysSendsSince() throws Exception {
        server.enqueue(new MockResponse().setBody(event("m1", "message", "a", false)));
        List<NtfyMessage> got = client.poll(ntfy, topics("upab12cd34aa"), "m0", true);
        assertEquals(1, got.size());
        RecordedRequest req = server.takeRequest(5, TimeUnit.SECONDS);
        assertEquals("/upab12cd34aa/json?poll=1&since=m0", req.getPath());
        assertEquals("Bearer " + TOKEN, req.getHeader("Authorization"));
        for (String bad : new String[] {null, ""}) {
            try {
                client.poll(ntfy, topics("upab12cd34aa"), bad, true);
                fail("poll without since");
            } catch (IllegalArgumentException expected) {
                // required
            }
        }
        assertEquals(1, server.getRequestCount());
    }

    @Test
    public void pollKeepsOnlyMessageEvents() throws Exception {
        server.enqueue(new MockResponse().setBody(event("o1", "open", null, false)
                + event("m1", "message", "a", false) + event("k1", "keepalive", null, false)));
        List<NtfyMessage> got = client.poll(ntfy, topics("upab12cd34aa"), "m0", true);
        assertEquals(1, got.size());
        assertEquals("m1", got.get(0).id);
    }

    @Test
    public void anUnknownSinceReplaysAndDuplicatesAreDroppedById() throws Exception {
        server.enqueue(new MockResponse().setBody(event("m1", "message", "a", false)
                + event("m2", "message", "b", false) + event("m3", "message", "c", false)));
        SeenIds seen = new SeenIds("m1,m2", 500);
        List<String> fresh = new ArrayList<>();
        for (NtfyMessage m : client.poll(ntfy, topics("upab12cd34aa"), "gone00000000", true)) {
            if (seen.add(m.id)) fresh.add(m.id);
        }
        assertEquals(Collections.singletonList("m3"), fresh);
    }

    @Test
    public void statusesMapToTheirKinds() throws Exception {
        int[] codes = {401, 403, 429, 500};
        NtfyException.Kind[] kinds = {NtfyException.Kind.UNAUTHORIZED, NtfyException.Kind.FORBIDDEN,
                NtfyException.Kind.RATE_LIMITED, NtfyException.Kind.PROTOCOL};
        for (int i = 0; i < codes.length; i++) {
            server.enqueue(new MockResponse().setResponseCode(codes[i]));
            try {
                client.poll(ntfy, topics("upab12cd34aa"), "m0", true);
                fail("status " + codes[i]);
            } catch (NtfyException e) {
                assertEquals(kinds[i], e.kind());
                assertFalse("no token in the message", String.valueOf(e.getMessage()).contains(TOKEN));
            }
            server.enqueue(new MockResponse().setResponseCode(codes[i]));
            Recorder r = new Recorder();
            client.stream(ntfy, topics("upab12cd34aa"), "m0", true, r);
            waitFor(r);
            assertEquals(kinds[i], r.closed.take().kind());
        }
    }

    @Test
    public void aRefusedConnectionIsUnreachable() throws Exception {
        int port;
        try (ServerSocket s = new ServerSocket(0)) {
            port = s.getLocalPort();
        }
        NtfyServer dead = new NtfyServer("http://127.0.0.1:" + port, TOKEN, "up", 1);
        try {
            client.poll(dead, topics("upab12cd34aa"), "m0", true);
            fail("refused");
        } catch (NtfyException e) {
            assertEquals(NtfyException.Kind.UNREACHABLE, e.kind());
        }
        Recorder r = new Recorder();
        client.stream(dead, topics("upab12cd34aa"), "m0", true, r);
        waitFor(r);
        assertEquals(NtfyException.Kind.UNREACHABLE, r.closed.take().kind());
    }

    @Test
    public void httpIsRefusedBeforeAnyRequestWhenNotAllowed() throws Exception {
        try {
            client.poll(ntfy, topics("upab12cd34aa"), "m0", false);
            fail("policy");
        } catch (NtfyException e) {
            assertEquals(NtfyException.Kind.HTTP_REFUSED, e.kind());
        }
        try {
            client.checkRead(ntfy, "upab12cd34aa", false);
            fail("policy");
        } catch (NtfyException e) {
            assertEquals(NtfyException.Kind.HTTP_REFUSED, e.kind());
        }
        Recorder r = new Recorder();
        Call call = client.stream(ntfy, topics("upab12cd34aa"), "m0", false, r);
        assertEquals(NtfyException.Kind.HTTP_REFUSED, r.closed.take().kind());
        assertTrue(call.isCanceled());
        assertEquals(0, server.getRequestCount());
    }

    @Test
    public void cleartextRefusalBySystemHasItsOwnKind() throws Exception {
        OkHttpClient refusing = new OkHttpClient.Builder()
                .addInterceptor(chain -> { throw new UnknownServiceException("CLEARTEXT not permitted"); })
                .build();
        NtfyClient c = new NtfyClient(refusing);
        try {
            c.poll(ntfy, topics("upab12cd34aa"), "m0", true);
            fail("cleartext");
        } catch (NtfyException e) {
            assertEquals(NtfyException.Kind.CLEARTEXT_BLOCKED, e.kind());
        }
        Recorder r = new Recorder();
        c.stream(ntfy, topics("upab12cd34aa"), "m0", true, r);
        waitFor(r);
        assertEquals(NtfyException.Kind.CLEARTEXT_BLOCKED, r.closed.take().kind());
    }

    @Test
    public void moreThan150TopicsIsRefused() throws Exception {
        List<String> many = new ArrayList<>();
        for (int i = 0; i <= NtfyClient.MAX_TOPICS; i++) many.add("upab12cd34" + i);
        try {
            client.stream(ntfy, many, "m0", true, new Recorder());
            fail("stream");
        } catch (IllegalArgumentException expected) {
            // refused
        }
        try {
            client.poll(ntfy, many, "m0", true);
            fail("poll");
        } catch (IllegalArgumentException expected) {
            // refused
        }
        assertEquals(0, server.getRequestCount());
        assertEquals(150, many.subList(0, 150).size());
        server.enqueue(new MockResponse());
        client.poll(ntfy, many.subList(0, 150), "m0", true);
    }

    @Test
    public void checkReadPassesOn200AndFailsForbiddenOn403() throws Exception {
        server.enqueue(new MockResponse().setBody("{\"success\":true}"));
        client.checkRead(ntfy, "upab12cd34aa", true);
        RecordedRequest req = server.takeRequest(5, TimeUnit.SECONDS);
        assertEquals("/upab12cd34aa/auth", req.getPath());
        assertEquals("Bearer " + TOKEN, req.getHeader("Authorization"));
        server.enqueue(new MockResponse().setResponseCode(403));
        try {
            client.checkRead(ntfy, "upab12cd34aa", true);
            fail("403");
        } catch (NtfyException e) {
            assertEquals(NtfyException.Kind.FORBIDDEN, e.kind());
        }
    }

    @Test
    public void aRedirectIsNotFollowed() throws Exception {
        server.enqueue(new MockResponse().setResponseCode(302).setHeader("Location", "http://127.0.0.1:1/x"));
        try {
            client.checkRead(ntfy, "upab12cd34aa", true);
            fail("redirect");
        } catch (NtfyException e) {
            assertEquals(NtfyException.Kind.PROTOCOL, e.kind());
        }
        assertEquals(1, server.getRequestCount());
    }

    @Test
    public void cancellingTheCallClosesCleanly() throws Exception {
        server.enqueue(new MockResponse().setBody(event("o1", "open", null, false))
                .setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.NO_RESPONSE));
        Recorder r = new Recorder();
        Call call = client.stream(ntfy, topics("upab12cd34aa"), "all", true, r);
        server.takeRequest(5, TimeUnit.SECONDS);
        call.cancel();
        waitFor(r);
        assertTrue(r.cleanClose);
        assertNull(r.closed.poll());
    }

    @Test
    public void serverUrlIsNormalized() {
        assertEquals("https://ntfy.exemple.test:8443/Path", NtfyServer.normalize("HTTPS://Ntfy.Exemple.TEST:8443/Path//"));
        assertEquals("https://ntfy.exemple.test", NtfyServer.normalize("https://ntfy.exemple.test/"));
        assertTrue(HttpPolicy.allowed("HTTPS://x.test", false));
        assertFalse(HttpPolicy.allowed("http://x.test", false));
        assertTrue(HttpPolicy.allowed("http://x.test", true));
        assertFalse(HttpPolicy.allowed("ftp://x.test", true));
    }

    @Test
    public void aBadEventLineIsAProtocolError() {
        try {
            NtfyMessage.parse("not json");
            fail("bad line");
        } catch (NtfyException e) {
            assertEquals(NtfyException.Kind.PROTOCOL, e.kind());
        }
    }

    /** Waits for the listener's onClosed. */
    private static void waitFor(Recorder r) throws InterruptedException {
        if (!r.done.await(10, TimeUnit.SECONDS)) fail("timeout waiting for the stream to close");
    }
}
