package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.security.ProviderException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import javax.crypto.spec.SecretKeySpec;
import okhttp3.Call;
import okhttp3.EventListener;
import okhttp3.OkHttpClient;
import okhttp3.mockwebserver.Dispatcher;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public class PushEngineTest {

    private static final String TOKEN = "tk_qwertzuiopasdfghjklyxcvbnm";
    private static final String PREFIX = "upab12cd34";
    private static final int CACHE = 43200;
    private static final long NOW = 1_790_000_000_000L;
    private static final long MINUTE = 60_000L;

    /** KeyValue over a concurrent map: the engine writes from OkHttp threads while the test reads. */
    static final class SyncKeyValue implements KeyValue {
        final Map<String, String> map = new ConcurrentHashMap<>();
        List<String> log;

        public String get(String k) { return map.get(k); }
        public void put(String k, String v) {
            if (log != null) log.add("put:" + k.substring(0, k.indexOf(':') + 1));
            map.put(k, v);
        }
        public void remove(String k) { map.remove(k); }
        public Set<String> keys() { return new HashSet<>(map.keySet()); }
    }

    /** Scheduled runnables kept with their delay; the test runs them by hand. */
    static final class HandScheduler implements PushEngine.Scheduler {
        static final class Task {
            final Runnable r;
            final long delay;

            Task(Runnable r, long delay) {
                this.r = r;
                this.delay = delay;
            }
        }

        final List<Task> tasks = new CopyOnWriteArrayList<>();

        public void schedule(Runnable r, long delayMs) { tasks.add(new Task(r, delayMs)); }
        public void cancelAll() { tasks.clear(); }

        Task last() { return tasks.get(tasks.size() - 1); }

        void runAll() {
            List<Task> copy = new ArrayList<>(tasks);
            tasks.clear();
            for (Task t : copy) t.r.run();
        }
    }

    /** What the engine asked the screen to do; active holds the tags currently drawn. */
    static final class FakeNotifier implements PushEngine.Notifier {
        final List<NotificationModel.Shown> shown = new CopyOnWriteArrayList<>();
        final List<String> cancelled = new CopyOnWriteArrayList<>();
        final List<String> cancelledAll = new CopyOnWriteArrayList<>();
        final Set<String> active = ConcurrentHashMap.newKeySet();
        final List<HealthSnapshot> statuses = new CopyOnWriteArrayList<>();
        /** Shows that throw before drawing anything. */
        final AtomicInteger failNext = new AtomicInteger();
        List<String> log;

        public void show(NotificationModel.Shown n) {
            if (failNext.getAndUpdate(v -> Math.max(0, v - 1)) > 0) throw new IllegalArgumentException("drawing failed");
            if (log != null) log.add("show:" + n.text);
            shown.add(n);
            active.add(n.tag);
        }

        public void cancel(String tag) {
            cancelled.add(tag);
            active.remove(tag);
        }

        public void cancelAll(String configId) {
            cancelledAll.add(configId);
            active.removeIf(t -> t.equals("summary:" + configId) || t.equals("status:" + configId)
                    || t.startsWith("chat:" + configId + ":") || t.startsWith("inbox:" + configId + ":"));
        }

        public Set<String> shownTags() { return new HashSet<>(active); }

        public void status(HealthSnapshot h) { statuses.add(h); }

        List<NotificationModel.Shown> onChannel(String channelId) {
            List<NotificationModel.Shown> out = new ArrayList<>();
            for (NotificationModel.Shown s : shown) {
                if (channelId.equals(s.channelId)) out.add(s);
            }
            return out;
        }

        List<NotificationModel.Shown> tagged(String tag) {
            List<NotificationModel.Shown> out = new ArrayList<>();
            for (NotificationModel.Shown s : shown) {
                if (tag.equals(s.tag)) out.add(s);
            }
            return out;
        }
    }

    /** Odoo answering get_session_info, /mail/data and unregister_devices by path. */
    static final class FakeOdoo extends Dispatcher {
        volatile String mailData = mailData(0);
        volatile boolean expired;
        final List<RecordedRequest> requests = new CopyOnWriteArrayList<>();
        final List<String> endpoints = new CopyOnWriteArrayList<>();

        @Override
        public MockResponse dispatch(RecordedRequest r) {
            requests.add(r);
            if (expired) {
                return new MockResponse().setBody(
                        "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":100,\"message\":\"Odoo Session Expired\"}}");
            }
            String path = r.getPath();
            if ("/web/session/get_session_info".equals(path)) return rpc("{}");
            if ("/mail/data".equals(path)) return rpc(mailData);
            if (path.startsWith("/web/dataset/call_kw/mail.push.device/unregister_devices")) {
                try {
                    String ep = new JSONObject(r.getBody().readUtf8()).getJSONObject("params")
                            .getJSONObject("kwargs").getString("endpoint");
                    endpoints.add(ep + " " + r.getHeader("Cookie"));
                    if (ep.contains("gone")) return new MockResponse().setResponseCode(404);
                    if (ep.contains("panne")) return new MockResponse().setResponseCode(500);
                } catch (Exception e) {
                    return new MockResponse().setResponseCode(500);
                }
                return rpc("null");
            }
            return new MockResponse().setResponseCode(404);
        }

        int count(String path) {
            int n = 0;
            for (RecordedRequest r : requests) {
                if (path.equals(r.getPath())) n++;
            }
            return n;
        }
    }

    private final SyncKeyValue storeKv = new SyncKeyValue();
    private final SyncKeyValue settingsKv = new SyncKeyValue();
    private final SyncKeyValue sessionsKv = new SyncKeyValue();
    private final SecretBox box = new SecretBox(() -> new SecretKeySpec(new byte[32], "AES"));
    private volatile long now = NOW;
    private final PushStore store = new PushStore(storeKv, box);
    private final PushSettingsStore settings = new PushSettingsStore(settingsKv);
    private final NativeSessions sessions = new NativeSessions(sessionsKv, box, () -> now);
    private final FakeNotifier notifier = new FakeNotifier();
    private final HandScheduler scheduler = new HandScheduler();
    private final FakeOdoo odoo = new FakeOdoo();

    /** Calls started on the ntfy client: OkHttp counts a call inside enqueue() or execute(), on the caller's thread. */
    private final AtomicInteger ntfyCalls = new AtomicInteger();

    private MockWebServer ntfyServer;
    private MockWebServer odooServer;
    private PushEngine engine;

    @Before
    public void setUp() throws Exception {
        ntfyServer = new MockWebServer();
        ntfyServer.start();
        odooServer = new MockWebServer();
        odooServer.setDispatcher(odoo);
        odooServer.start();
    }

    @After
    public void tearDown() throws Exception {
        if (engine != null) engine.stopRealtime();
        ntfyServer.shutdown();
        odooServer.shutdown();
    }

    // ---- helpers ----

    private PushEngine engine() {
        if (engine == null) engine = newEngine();
        return engine;
    }

    private PushEngine newEngine() {
        OkHttpClient counted = new OkHttpClient.Builder().eventListener(new EventListener() {
            @Override
            public void callStart(Call call) {
                ntfyCalls.incrementAndGet();
            }
        }).build();
        return new PushEngine(store, settings, sessions, new NtfyClient(counted),
                new OdooDirect(new OkHttpClient()), notifier, () -> now, scheduler);
    }

    private List<HandScheduler.Task> immediate() {
        List<HandScheduler.Task> out = new ArrayList<>();
        for (HandScheduler.Task t : scheduler.tasks) {
            if (t.delay == 0) out.add(t);
        }
        return out;
    }

    private static AccountView account(String configId, String label) {
        Map<Long, ChannelInfo> ch = new HashMap<>();
        ch.put(42L, new ChannelInfo("Alice Martin", "chat"));
        ch.put(43L, new ChannelInfo("Bruno Tremblay", "chat"));
        return new AccountView(configId, label, LockScreenMode.ALWAYS, ch);
    }

    private void mirror(int level, boolean allowHttp, AccountView... accounts) {
        settings.put(level, allowHttp, Collections.<String, String>emptyMap(), Arrays.asList(accounts));
    }

    private NtfyServer addNtfy(MockWebServer s, int cache) {
        NtfyServer n = new NtfyServer(s.url("/").toString(), TOKEN, PREFIX, cache);
        store.putNtfy(n);
        return store.ntfy(n.url);
    }

    private void mirrorSession(String configId, String sid) {
        sessions.put(new NativeSession(configId, odooServer.url("/").toString(), "db_exemple", sid, 1L));
    }

    private static PushLevelPolicy.Effective level(int l) {
        return PushLevelPolicy.resolve(l, new PushLevelPolicy.PowerState(false, false, false, 80), true,
                PushLevelPolicy.NO_CLIMB);
    }

    private static MockResponse rpc(String result) {
        return new MockResponse().setBody("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":" + result + "}");
    }

    /** A /mail/data result counting total unread through the inbox counter, channel 42 read. */
    static String mailData(int total) {
        return "{\"Store\":{\"inbox\":{\"counter\":" + total + "}},\"discuss.channel\":[{\"id\":42,"
                + "\"channel_type\":\"chat\",\"is_pinned\":true,\"selfMember\":{\"message_unread_counter\":0}}]}";
    }

    private static String event(String id, String event, String topic) {
        return "{\"id\":\"" + id + "\",\"time\":1790000000,\"event\":\"" + event + "\",\"topic\":\"" + topic + "\"}\n";
    }

    private static String open(String topic) {
        return event("o" + System.nanoTime(), "open", topic);
    }

    private static String raw(String id, String topic, byte[] body) {
        return "{\"id\":\"" + id + "\",\"time\":1790000000,\"event\":\"message\",\"topic\":\"" + topic
                + "\",\"message\":\"" + B64.encode(body, false) + "\",\"encoding\":\"base64\"}\n";
    }

    /** One encrypted Odoo push for a discuss channel, as ntfy streams it. */
    private static String push(Subscription sub, String id, long channelId, String author, String text)
            throws Exception {
        String json = "{\"title\":\"" + author + "\",\"options\":{\"body\":\"" + text
                + "\",\"data\":{\"model\":\"discuss.channel\",\"res_id\":" + channelId + "}}}";
        byte[] body = WebPushTestEncrypt.encrypt(json.getBytes(StandardCharsets.UTF_8), sub.publicKey,
                sub.authSecret, 4096);
        return raw(id, sub.topic, body);
    }

    private static void await(BooleanSupplier c, String what) throws InterruptedException {
        long end = System.currentTimeMillis() + 5000;
        while (!c.getAsBoolean()) {
            if (System.currentTimeMillis() > end) throw new AssertionError("timed out waiting for " + what);
            Thread.sleep(10);
        }
    }

    private static void inRange(long v, long lo, long hi) {
        assertTrue(v + " not in [" + lo + ", " + hi + "]", v >= lo && v <= hi);
    }

    private void awaitClosed(int n) throws InterruptedException {
        await(() -> scheduler.tasks.size() >= n, n + " scheduled reconnect(s)");
    }

    private JSONObject ntfyHealth(JSONObject h, String url) throws Exception {
        JSONArray arr = h.getJSONArray("ntfys");
        for (int i = 0; i < arr.length(); i++) {
            if (url.equals(arr.getJSONObject(i).getString("url"))) return arr.getJSONObject(i);
        }
        throw new AssertionError("no health entry for the ntfy");
    }

    private JSONObject accountHealth(JSONObject h, String configId) throws Exception {
        JSONArray arr = h.getJSONArray("accounts");
        for (int i = 0; i < arr.length(); i++) {
            if (configId.equals(arr.getJSONObject(i).getString("configId"))) return arr.getJSONObject(i);
        }
        throw new AssertionError("no health entry for " + configId);
    }

    // ---- streams ----

    @Test
    public void twoAccountsOnOneNtfyShareOneStream() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"), account("cfg2", "Serveur B"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        Subscription b = store.subscribe("cfg2", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)));
        engine().startRealtime();
        awaitClosed(1);
        assertEquals(1, ntfyServer.getRequestCount());
        String path = ntfyServer.takeRequest().getPath();
        assertTrue(path, path.contains(a.topic));
        assertTrue(path, path.contains(b.topic));
        assertTrue(path, path.contains("/json?since="));
    }

    @Test
    public void twoNtfyServersGetOneStreamEach() throws Exception {
        MockWebServer other = new MockWebServer();
        other.start();
        try {
            mirror(1, true, account("cfg1", "Serveur A"), account("cfg2", "Serveur B"));
            Subscription a = store.subscribe("cfg1", addNtfy(ntfyServer, CACHE).url, false);
            Subscription b = store.subscribe("cfg2", addNtfy(other, CACHE).url, false);
            ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)));
            other.enqueue(new MockResponse().setBody(open(b.topic)));
            engine().startRealtime();
            awaitClosed(2);
            assertEquals(1, ntfyServer.getRequestCount());
            assertEquals(1, other.getRequestCount());
            assertTrue(ntfyServer.takeRequest().getPath().startsWith("/" + a.topic + "/json"));
            assertTrue(other.takeRequest().getPath().startsWith("/" + b.topic + "/json"));
        } finally {
            if (engine != null) engine.stopRealtime();
            other.shutdown();
        }
    }

    @Test
    public void aMessageShowsOnItsAccountsConversation() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"), account("cfg2", "Serveur B"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        store.subscribe("cfg1", n.url, false);
        Subscription b = store.subscribe("cfg2", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(open(b.topic) + push(b, "m1", 43, "Bruno Tremblay", "Bonjour")));
        engine().startRealtime();
        awaitClosed(1);
        assertEquals(1, notifier.shown.size());
        NotificationModel.Shown s = notifier.shown.get(0);
        assertEquals("chat:cfg2:43", s.tag);
        assertEquals(NotificationModel.chatChannelId("cfg2"), s.channelId);
        assertEquals("Bruno Tremblay", s.conversationTitle);
        assertEquals("Bonjour", s.text);
        assertEquals("m1", store.cursor(n.url));
        assertEquals(NOW, store.lastContactAt(n.url));
    }

    @Test
    public void aStreamedMessageIsProcessedInsideTheWakeHold() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + event("k1", "keepalive", a.topic)
                + push(a, "m1", 42, "Alice Martin", "Bonjour")));
        List<String> log = new CopyOnWriteArrayList<>();
        notifier.log = log;
        engine().setWake(new PushEngine.Wake() {
            public void acquire() { log.add("acquire"); }
            public void release() { log.add("release"); }
        });
        engine().startRealtime();
        awaitClosed(1);
        assertEquals(Arrays.asList("acquire", "show:Bonjour", "release"), log);
    }

    @Test
    public void aReplayAfterReconnectShowsEachMessageOnce() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        String m1 = push(a, "m1", 42, "Alice Martin", "un");
        String m2 = push(a, "m2", 42, "Alice Martin", "deux");
        String m3 = push(a, "m3", 42, "Alice Martin", "trois");
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + m1 + m2));
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + m1 + m2 + m3));
        engine().startRealtime();
        awaitClosed(1);
        scheduler.runAll();
        awaitClosed(1);
        assertEquals(2, ntfyServer.getRequestCount());
        ntfyServer.takeRequest();
        assertTrue(ntfyServer.takeRequest().getPath().endsWith("since=m2"));
        List<String> texts = new ArrayList<>();
        for (NotificationModel.Shown s : notifier.shown) texts.add(s.text);
        assertEquals(Arrays.asList("un", "deux", "trois"), texts);
    }

    @Test
    public void anUndecryptableMessageIsDroppedAndTheNextOneShows() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        byte[] junk = new byte[120];
        new SecureRandom().nextBytes(junk);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + raw("m1", a.topic, junk)
                + push(a, "m2", 42, "Alice Martin", "lisible")));
        engine().startRealtime();
        awaitClosed(1);
        assertEquals(1, notifier.shown.size());
        assertEquals("lisible", notifier.shown.get(0).text);
        assertEquals("m2", store.cursor(n.url));
        assertEquals(1, engine.health().toJson().getInt("undecryptable"));
    }

    @Test
    public void aKeyThatNoLongerOpensIsRecordedAndTheStreamGoesOn() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"), account("cfg2", "Serveur B"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        Subscription b = store.subscribe("cfg2", n.url, false);
        JSONObject rec = new JSONObject(storeKv.get("sub:cfg1"));
        rec.put("priv", "v1:AAAAAAAAAAAAAAAA:AAAA");
        storeKv.put("sub:cfg1", rec.toString());
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + push(a, "m1", 42, "Alice Martin", "perdu")
                + push(b, "m2", 43, "Bruno Tremblay", "reçu")));
        engine().startRealtime();
        awaitClosed(1);
        assertEquals(1, notifier.shown.size());
        assertEquals("reçu", notifier.shown.get(0).text);
        JSONObject h = engine.health().toJson();
        assertEquals(1, h.getInt("faults"));
        assertEquals(0, h.getInt("undecryptable"));
    }

    @Test
    public void aShownMessageCarriesItsNtfyTime() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + push(a, "m1", 42, "Alice Martin", "vu")));
        engine().startRealtime();
        awaitClosed(1);
        assertEquals(1, notifier.shown.size());
        assertEquals(1_790_000_000_000L, notifier.shown.get(0).at);
    }

    @Test
    public void nothingShowsWhileTheAppIsInTheForeground() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        settings.setForeground(true);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + push(a, "m1", 42, "Alice Martin", "vu")));
        engine().startRealtime();
        awaitClosed(1);
        assertTrue(notifier.shown.isEmpty());
        assertEquals("m1", store.cursor(n.url));
    }

    @Test
    public void aMessageClearEventChangesNothing() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        notifier.active.add("chat:cfg1:42");
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + event("x1", "message_clear", a.topic)
                + event("x2", "message_delete", a.topic) + event("x3", "poll_request", a.topic)));
        engine().startRealtime();
        awaitClosed(1);
        assertTrue(notifier.shown.isEmpty());
        assertTrue(notifier.cancelled.isEmpty());
        assertTrue(notifier.cancelledAll.isEmpty());
        assertNull(store.cursor(n.url));
    }

    @Test
    public void aDroppedStreamReconnectsWithTheSavedCursorAfterTheBackoff() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + push(a, "m1", 42, "Alice Martin", "un")));
        ntfyServer.enqueue(new MockResponse().setResponseCode(503));
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)));
        engine().startRealtime();
        awaitClosed(1);
        inRange(scheduler.last().delay, 5_000, 6_000);
        assertEquals(1, ntfyCalls.get());

        scheduler.runAll();
        awaitClosed(1);
        ntfyServer.takeRequest();
        assertTrue(ntfyServer.takeRequest().getPath().endsWith("since=m1"));
        inRange(scheduler.last().delay, 15_000, 18_000);

        scheduler.runAll();
        awaitClosed(1);
        assertTrue(ntfyServer.takeRequest().getPath().endsWith("since=m1"));
        // an open resets the backoff
        inRange(scheduler.last().delay, 5_000, 6_000);
    }

    @Test
    public void networkBackReconnectsAtOnce() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)));
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)));
        engine().startRealtime();
        awaitClosed(1);
        engine.onNetworkAvailable();
        await(() -> ntfyServer.getRequestCount() == 2, "the reconnect on network back");
        awaitClosed(2);
        // the reconnect that was waiting is spent: running it opens nothing more
        assertEquals(2, ntfyCalls.get());
        scheduler.tasks.get(0).r.run();
        assertEquals(2, ntfyCalls.get());
    }

    @Test
    public void a401KeepsTheLongDelayAndShowsUnauthorizedInHealth() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setResponseCode(401));
        ntfyServer.enqueue(new MockResponse().setResponseCode(401));
        engine().startRealtime();
        awaitClosed(1);
        inRange(scheduler.last().delay, 300_000, 360_000);
        JSONObject h = ntfyHealth(engine.health().toJson(), n.url);
        assertEquals("error", h.getString("state"));
        assertEquals("unauthorized", h.getString("reason"));

        engine.onNetworkAvailable();
        assertEquals(1, ntfyCalls.get());

        scheduler.runAll();
        awaitClosed(1);
        assertEquals(2, ntfyServer.getRequestCount());
        inRange(scheduler.last().delay, 300_000, 360_000);
        assertEquals("unauthorized", ntfyHealth(engine.health().toJson(), n.url).getString("reason"));
        JSONObject acc = accountHealth(engine.health().toJson(), "cfg1");
        assertEquals("ntfy", acc.getString("via"));
        assertEquals("error", acc.getString("state"));
    }

    @Test
    public void turningAllowHttpOnReconnects() throws Exception {
        mirror(1, false, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)));
        engine().startRealtime();
        awaitClosed(1);
        assertEquals(0, ntfyServer.getRequestCount());
        assertEquals("http_refused", ntfyHealth(engine.health().toJson(), n.url).getString("reason"));

        mirror(1, true, account("cfg1", "Serveur A"));
        engine.onSettingsChanged();
        await(() -> ntfyServer.getRequestCount() == 1, "the stream reopened with http allowed");
    }

    // ---- Odoo-direct summary ----

    @Test
    public void silenceAboveTheCacheRunsTheOdooDirectSummaryOnce() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        store.setCursor(n.url, "m0", NOW - (CACHE + 1) * 1000L);
        mirrorSession("cfg1", "sid_exemple_secret");
        odoo.mailData = mailData(2);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + push(a, "m1", 42, "Alice Martin", "rejoué")));
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)));
        engine().startRealtime();
        awaitClosed(2);
        // the check waits for the scheduler: the replay behind the open is not held by Odoo
        assertEquals(1, immediate().size());
        assertEquals(0, odoo.requests.size());
        assertEquals("rejoué", notifier.shown.get(0).text);
        assertTrue(ntfyServer.takeRequest().getPath().endsWith("since=m0"));

        immediate().get(0).r.run();
        assertEquals(1, odoo.count("/mail/data"));
        assertEquals(1, notifier.tagged("summary:cfg1").size());

        scheduler.runAll();
        awaitClosed(1);
        assertEquals(2, ntfyCalls.get());
        assertTrue(immediate().isEmpty());
        assertEquals(1, odoo.count("/mail/data"));
    }

    @Test
    public void aCheckOwedAfterASilenceRunsAtTheNextDueRunWhenTheStreamStopped() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        store.setCursor(n.url, "m0", NOW - (CACHE + 1) * 1000L);
        mirrorSession("cfg1", "sid_exemple_secret");
        odoo.mailData = mailData(2);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)));
        engine().startRealtime();
        awaitClosed(2);
        engine.stopRealtime();
        assertTrue(scheduler.tasks.isEmpty());
        assertEquals(0, odoo.requests.size());

        newEngine().runDue(level(1));
        assertEquals(1, odoo.count("/mail/data"));
        assertEquals(1, notifier.tagged("summary:cfg1").size());
    }

    @Test
    public void anAccountWithoutNtfyIsCheckedAtEachDueRun() throws Exception {
        mirror(3, true, account("cfg2", "Serveur B"));
        mirrorSession("cfg2", "sid_exemple_secret");
        engine().runDue(level(3));
        assertEquals(1, odoo.count("/mail/data"));
        engine.runDue(level(3));
        assertEquals(2, odoo.count("/mail/data"));
        engine.runDue(level(1));
        assertEquals(3, odoo.count("/mail/data"));
        engine.runDue(level(5));
        assertEquals(3, odoo.count("/mail/data"));
        assertEquals("cookie", "session_id=sid_exemple_secret",
                odoo.requests.get(odoo.requests.size() - 1).getHeader("Cookie"));
        JSONObject acc = accountHealth(engine.health().toJson(), "cfg2");
        assertEquals("odoo", acc.getString("via"));
        assertEquals("ok", acc.getString("state"));
    }

    @Test
    public void theSummaryAlertsOnARiseUpdatesSilentlyOnADropGoesAtZero() throws Exception {
        mirror(3, true, account("cfg2", "Serveur B"));
        mirrorSession("cfg2", "sid_exemple_secret");
        odoo.mailData = mailData(3);
        engine().runDue(level(3));
        List<NotificationModel.Shown> s = notifier.tagged("summary:cfg2");
        assertEquals(1, s.size());
        assertFalse(s.get(0).silent);
        assertTrue(s.get(0).publicTitle, s.get(0).publicTitle.contains("3"));
        assertEquals("/chat", s.get(0).openUrl);

        odoo.mailData = mailData(2);
        engine.runDue(level(3));
        s = notifier.tagged("summary:cfg2");
        assertEquals(2, s.size());
        assertTrue(s.get(1).silent);
        assertTrue(s.get(1).publicTitle.contains("2"));

        engine.runDue(level(3));
        assertEquals(2, notifier.tagged("summary:cfg2").size());

        odoo.mailData = mailData(5);
        engine.runDue(level(3));
        s = notifier.tagged("summary:cfg2");
        assertEquals(3, s.size());
        assertFalse(s.get(2).silent);

        odoo.mailData = mailData(0);
        engine.runDue(level(3));
        assertTrue(notifier.cancelled.contains("summary:cfg2"));
        assertEquals(3, notifier.tagged("summary:cfg2").size());
    }

    @Test
    public void readConversationsLoseTheirNotificationAtTheCheck() throws Exception {
        mirror(3, true, account("cfg2", "Serveur B"));
        mirrorSession("cfg2", "sid_exemple_secret");
        notifier.active.add("chat:cfg2:42");
        notifier.active.add("chat:cfg2:43");
        odoo.mailData = mailData(1);
        engine().runDue(level(3));
        assertTrue(notifier.cancelled.contains("chat:cfg2:42"));
        assertFalse(notifier.cancelled.contains("chat:cfg2:43"));
        assertTrue(notifier.active.contains("chat:cfg2:43"));
    }

    @Test
    public void anExpiredSessionStopsTheChecksAndSaysSoOnce() throws Exception {
        mirror(3, true, account("cfg2", "Serveur B"));
        mirrorSession("cfg2", "sid_exemple_secret");
        odoo.expired = true;
        engine().runDue(level(3));
        assertTrue(sessions.expired("cfg2"));
        List<NotificationModel.Shown> st = notifier.onChannel("status");
        assertEquals(1, st.size());
        assertEquals("status:cfg2", st.get(0).tag);
        assertTrue(st.get(0).text, st.get(0).text.contains("Serveur B"));
        int calls = odoo.requests.size();
        assertEquals("session_expired", accountHealth(engine.health().toJson(), "cfg2").getString("state"));

        engine.runDue(level(3));
        engine.runDue(level(3));
        assertEquals(calls, odoo.requests.size());
        assertEquals(1, notifier.onChannel("status").size());

        odoo.expired = false;
        mirrorSession("cfg2", "sid_exemple_neuf");
        engine.runDue(level(3));
        assertEquals(1, odoo.count("/mail/data"));
        assertTrue(notifier.cancelled.contains("status:cfg2"));
    }

    // ---- polls, status, unregisters ----

    @Test
    public void twoFailedPollsPostOneStatusNotificationASuccessRemovesIt() throws Exception {
        mirror(3, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setResponseCode(500));
        ntfyServer.enqueue(new MockResponse().setResponseCode(500));
        ntfyServer.enqueue(new MockResponse().setResponseCode(500));
        ntfyServer.enqueue(new MockResponse().setBody(""));
        engine().runDue(level(3));
        assertTrue(notifier.onChannel("status").isEmpty());
        now += 15 * MINUTE;
        engine.runDue(level(3));
        List<NotificationModel.Shown> st = notifier.onChannel("status");
        assertEquals(1, st.size());
        assertEquals("status:cfg1", st.get(0).tag);
        assertTrue(st.get(0).text, st.get(0).text.contains("Serveur A"));
        now += 15 * MINUTE;
        engine.runDue(level(3));
        assertEquals(1, notifier.onChannel("status").size());
        assertFalse(notifier.cancelled.contains("status:cfg1"));
        now += 15 * MINUTE;
        engine.runDue(level(3));
        assertEquals(4, ntfyServer.getRequestCount());
        assertTrue(notifier.cancelled.contains("status:cfg1"));
        assertEquals(1, notifier.onChannel("status").size());
    }

    @Test
    public void aPollShowsItsMessagesThroughTheSamePath() throws Exception {
        mirror(3, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(push(a, "m1", 42, "Alice Martin", "relevé")));
        ntfyServer.enqueue(new MockResponse().setBody(push(a, "m1", 42, "Alice Martin", "relevé")));
        engine().runDue(level(3));
        now += 15 * MINUTE;
        engine.runDue(level(3));
        assertEquals(1, notifier.shown.size());
        assertEquals("relevé", notifier.shown.get(0).text);
        RecordedRequest first = ntfyServer.takeRequest();
        assertTrue(first.getPath(), first.getPath().contains("poll=1"));
        assertTrue(ntfyServer.takeRequest().getPath().endsWith("since=m1"));
        JSONObject h = engine.health().toJson();
        assertEquals("poll_15", h.getString("mode"));
        assertEquals("polling", ntfyHealth(h, n.url).getString("state"));
        assertEquals("cfg1", ntfyHealth(h, n.url).getJSONArray("configIds").getString(0));
        assertFalse(h.getBoolean("serviceAlive"));
    }

    @Test
    public void level4PollsOnceAnHour() throws Exception {
        mirror(4, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        store.subscribe("cfg1", n.url, false);
        for (int i = 0; i < 3; i++) ntfyServer.enqueue(new MockResponse().setBody(""));
        engine().runDue(level(4));
        assertEquals(1, ntfyServer.getRequestCount());
        for (int i = 0; i < 3; i++) {
            now += 15 * MINUTE;
            engine.runDue(level(4));
        }
        assertEquals(1, ntfyServer.getRequestCount());
        now += 15 * MINUTE;
        engine.runDue(level(4));
        assertEquals(2, ntfyServer.getRequestCount());
        assertEquals("poll_60", engine.health().toJson().getString("mode"));
    }

    @Test
    public void aPendingUnregisterRunsWithTheSessionCopyThenForgetsIt() throws Exception {
        mirror(3, true, account("cfg2", "Serveur B"));
        mirrorSession("cfg2", "sid_exemple_garde");
        mirrorSession("cfg3", "sid_exemple_parti");
        sessions.addPendingUnregister("cfg3", "https://ntfy.exemple.test/upab12cd34ancien");
        sessions.addPendingUnregister("cfg2", "https://ntfy.exemple.test/upab12cd34gone");
        engine().runDue(level(3));
        assertTrue(odoo.endpoints.contains(
                "https://ntfy.exemple.test/upab12cd34ancien session_id=sid_exemple_parti"));
        assertTrue(odoo.endpoints.contains(
                "https://ntfy.exemple.test/upab12cd34gone session_id=sid_exemple_garde"));
        assertTrue(sessions.pending().isEmpty());
        assertNull(sessions.get("cfg3"));
        assertNotNull(sessions.get("cfg2"));
    }

    @Test
    public void anAccountRemovedFromTheMirrorLosesItsNotifications() throws Exception {
        mirror(3, true, account("cfg1", "Serveur A"), account("cfg2", "Serveur B"));
        notifier.active.addAll(Arrays.asList("chat:cfg1:42", "chat:cfg2:42", "summary:cfg2"));
        engine();
        mirror(3, true, account("cfg1", "Serveur A"));
        engine.onSettingsChanged();
        assertEquals(Collections.singletonList("cfg2"), notifier.cancelledAll);
        assertEquals(Collections.singleton("chat:cfg1:42"), notifier.active);

        // a later engine (a new process) still clears a tag left by an account it never knew
        notifier.active.add("inbox:cfg9:project.task:7");
        newEngine().onSettingsChanged();
        assertEquals(Collections.singleton("chat:cfg1:42"), notifier.active);
    }

    @Test
    public void aRestartedEngineShowsEachReplayedMessageOnce() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        String m1 = push(a, "m1", 42, "Alice Martin", "un");
        String m2 = push(a, "m2", 42, "Alice Martin", "deux");
        String m3 = push(a, "m3", 42, "Alice Martin", "trois");
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + m1 + m2));
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + m1 + m2 + m3));
        engine().startRealtime();
        awaitClosed(1);
        engine.stopRealtime();

        // a new process: same stores, a fresh engine, ntfy replaying its cache
        engine = newEngine();
        engine.startRealtime();
        awaitClosed(1);
        ntfyServer.takeRequest();
        assertTrue(ntfyServer.takeRequest().getPath().endsWith("since=m2"));
        List<String> texts = new ArrayList<>();
        for (NotificationModel.Shown s : notifier.shown) texts.add(s.text);
        assertEquals(Arrays.asList("un", "deux", "trois"), texts);
    }

    @Test
    public void theSeenIdsAreSavedWithTheCursorAfterTheMessageIsShown() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        List<String> log = new CopyOnWriteArrayList<>();
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + push(a, "m1", 42, "Alice Martin", "un")));
        engine();
        storeKv.log = log;
        notifier.log = log;
        engine.startRealtime();
        awaitClosed(1);
        int shown = log.indexOf("show:un");
        assertTrue(log.toString(), shown >= 0);
        assertTrue(log.toString(), log.lastIndexOf("put:seen:") > shown);
        assertEquals(log.toString(), log.indexOf("put:seen:"), log.lastIndexOf("put:seen:"));
    }

    @Test
    public void aFailingNotifierLosesOnlyThatMessage() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        notifier.failNext.set(1);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + push(a, "m1", 42, "Alice Martin", "perdu")
                + push(a, "m2", 43, "Bruno Tremblay", "reçu")));
        engine().startRealtime();
        awaitClosed(1);
        assertEquals(1, notifier.shown.size());
        assertEquals("reçu", notifier.shown.get(0).text);
        assertEquals("m2", store.cursor(n.url));
        assertEquals(1, engine.health().toJson().getInt("faults"));
        // the stream ended cleanly, not on a listener failure
        assertEquals("connecting", ntfyHealth(engine.health().toJson(), n.url).getString("state"));
        assertTrue(ntfyHealth(engine.health().toJson(), n.url).isNull("reason"));
    }

    @Test
    public void anUnregisterThatFailsKeepsItsEntries() throws Exception {
        mirror(3, true, account("cfg2", "Serveur B"));
        engine().onSettingsChanged();
        mirrorSession("cfg3", "sid_exemple_parti");
        sessions.addPendingUnregister("cfg3", "https://ntfy.exemple.test/upab12cd34ancien");
        sessions.addPendingUnregister("cfg3", "https://ntfy.exemple.test/upab12cd34panne");
        sessions.addPendingUnregister("cfg3", "https://ntfy.exemple.test/upab12cd34suivant");
        engine.runDue(level(3));
        List<PendingUnregister> left = sessions.pending();
        List<String> eps = new ArrayList<>();
        for (PendingUnregister p : left) eps.add(p.endpoint);
        assertEquals(Arrays.asList("https://ntfy.exemple.test/upab12cd34panne",
                "https://ntfy.exemple.test/upab12cd34suivant"), eps);
        assertNotNull(sessions.get("cfg3"));
    }

    @Test
    public void aRemovedAccountWithoutNtfyLosesItsSessionCopy() throws Exception {
        mirror(3, true, account("cfg1", "Serveur A"), account("cfg2", "Serveur B"));
        mirrorSession("cfg1", "sid_exemple_garde");
        mirrorSession("cfg2", "sid_exemple_parti");
        engine().onSettingsChanged();
        mirror(3, true, account("cfg1", "Serveur A"));
        engine.onSettingsChanged();
        assertNull(sessions.get("cfg2"));
        assertNotNull(sessions.get("cfg1"));
    }

    @Test
    public void aRemovedAccountLosesItsSessionOnceItsEntriesExpire() throws Exception {
        mirror(3, true, account("cfg1", "Serveur A"), account("cfg3", "Serveur C"));
        mirrorSession("cfg3", "sid_exemple_parti");
        engine().onSettingsChanged();
        sessions.addPendingUnregister("cfg3", "https://ntfy.exemple.test/upab12cd34panne");
        mirror(3, true, account("cfg1", "Serveur A"));
        engine.onSettingsChanged();
        assertNotNull(sessions.get("cfg3"));
        engine.runDue(level(3));
        assertNotNull(sessions.get("cfg3"));

        now += NativeSessions.PENDING_MAX_AGE_MS + 1;
        // a session mirrored after the last publish belongs to an account on its way in
        sessions.put(new NativeSession("cfg4", odooServer.url("/").toString(), "db_exemple", "sid_exemple_neuf", now));
        engine.runDue(level(3));
        assertTrue(sessions.pending().isEmpty());
        assertNull(sessions.get("cfg3"));
        assertNotNull(sessions.get("cfg4"));
    }

    // ---- a dead service, a dead stream, a Keystore fault ----

    @Test
    public void aLevelThatWantsTheServiceWithNoneRunningPollsAndSaysSo() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(push(a, "m1", 42, "Alice Martin", "relevé")));
        ntfyServer.enqueue(new MockResponse().setResponseCode(500));
        ntfyServer.enqueue(new MockResponse().setResponseCode(500));
        engine().runPeriod(level(1), false);
        assertEquals(1, notifier.shown.size());
        assertEquals("relevé", notifier.shown.get(0).text);
        assertTrue(ntfyServer.takeRequest().getPath().contains("poll=1"));
        JSONObject h = engine.health().toJson();
        assertEquals(1, h.getInt("effectiveLevel"));
        assertEquals("poll_15", h.getString("mode"));
        assertFalse(h.getBoolean("serviceAlive"));

        // two failed runs in a row say so, as at a level without the service
        now += 15 * MINUTE;
        engine.runPeriod(level(1), false);
        assertTrue(notifier.onChannel("status").isEmpty());
        now += 15 * MINUTE;
        engine.runPeriod(level(1), false);
        assertEquals(1, notifier.onChannel("status").size());

        // a running service listens itself: the run polls nothing
        now += 15 * MINUTE;
        engine.runPeriod(level(1), true);
        assertEquals(3, ntfyServer.getRequestCount());
    }

    @Test
    public void aWaitingStreamReopensAtTheDueRun() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)));
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)));
        engine().startRealtime();
        awaitClosed(1);
        // the backoff's clock stops in deep sleep: the reconnect may never come
        engine.runDue(level(1));
        await(() -> ntfyServer.getRequestCount() == 2, "the reopen of the due run");
    }

    @Test
    public void aStreamSilentForThreeKeepalivesReopensAtTheDueRun() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        String opened = open(a.topic);
        // the body promises more than it sends: the stream stays open, silent
        ntfyServer.enqueue(new MockResponse().setBody(opened).setHeader("Content-Length", "100000"));
        ntfyServer.enqueue(new MockResponse().setBody(opened).setHeader("Content-Length", "100000"));
        engine().startRealtime();
        await(() -> "connected".equals(state(n.url)), "the stream open");
        PushStrings s = settings.strings();
        assertEquals(s.get("permanent_listening_one"), engine.health().permanentLine(s, settings.accounts()));

        now += PushEngine.STALE_CONTACT_MS - 1000;
        engine.runDue(level(1));
        assertEquals(1, ntfyServer.getRequestCount());

        now += 2000;
        assertEquals(s.get("permanent_waiting"), engine.health().permanentLine(s, settings.accounts()));
        engine.runDue(level(1));
        await(() -> ntfyServer.getRequestCount() == 2, "the reopen of a silent stream");
    }

    @Test
    public void aKeystoreFaultLeavesTheEngineStanding() throws Exception {
        mirror(3, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        store.subscribe("cfg1", n.url, false);
        mirrorSession("cfg1", "sid_exemple_secret");
        SecretBox broken = new SecretBox(() -> {
            throw new ProviderException("keystore fault");
        });
        PushEngine e = new PushEngine(new PushStore(storeKv, broken), settings,
                new NativeSessions(sessionsKv, broken, () -> now), new NtfyClient(new OkHttpClient()),
                new OdooDirect(new OkHttpClient()), notifier, () -> now, scheduler);
        e.onSettingsChanged();
        e.runDue(level(3));
        JSONObject h = e.health().toJson();
        assertEquals(0, h.getJSONArray("ntfys").length());
        assertEquals("no_session", accountHealth(h, "cfg1").getString("state"));
        assertEquals(0, ntfyServer.getRequestCount());
        assertEquals(0, odoo.requests.size());
    }

    @Test
    public void aSubscribeAfterAPublishKeepsASessionCopiedMeanwhile() throws Exception {
        mirror(3, true, account("cfg1", "Serveur A"));
        engine().onSettingsChanged();
        now += MINUTE;
        // an account on its way in: its session is copied before the publish that names it
        sessions.put(new NativeSession("cfg2", odooServer.url("/").toString(), "db_exemple", "sid_exemple_neuf", now));
        now += MINUTE;
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        store.subscribe("cfg1", n.url, false);
        engine.onStoresChanged();
        assertNotNull(sessions.get("cfg2"));
    }

    @Test
    public void anOwedCheckCutShortIsOwedStill() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        store.subscribe("cfg1", n.url, false);
        mirrorSession("cfg1", "sid_exemple_secret");
        settings.setEngineState("owe:cfg1", "1");
        odoo.mailData = mailData(2);
        // the summary's drawing fails: the check ends as a death would end it
        notifier.failNext.set(1);
        try {
            engine().runDue(level(1));
        } catch (IllegalArgumentException expected) {
            // drawing failed
        }
        assertNotNull(settings.engineState("owe:cfg1"));

        newEngine().runDue(level(1));
        assertEquals(1, notifier.tagged("summary:cfg1").size());
        assertNull(settings.engineState("owe:cfg1"));
    }

    private String state(String url) {
        try {
            return ntfyHealth(engine.health().toJson(), url).getString("state");
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }
}
