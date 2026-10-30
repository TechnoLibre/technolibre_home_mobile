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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import javax.crypto.spec.SecretKeySpec;
import okhttp3.Call;
import okhttp3.EventListener;
import okhttp3.Interceptor;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okhttp3.mockwebserver.Dispatcher;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import okio.BufferedSink;
import okio.Okio;
import okio.Pipe;
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
        /** Per chat tag, the message ids of its stack in order (0: a message without id). */
        final Map<String, List<Long>> ids = new ConcurrentHashMap<>();
        /** When each tag was last posted, epoch ms, on the device clock (postClock at show). */
        final Map<String, Long> postedAt = new ConcurrentHashMap<>();
        /** The send time each tag was last drawn with (its when: the ntfy time), epoch ms. */
        final Map<String, Long> sentAt = new ConcurrentHashMap<>();
        /** The device clock show() stamps postedAt with. */
        volatile java.util.function.LongSupplier postClock = () -> 0L;
        /** trimRead calls, "tag@lastMessageId". */
        final List<String> trims = new CopyOnWriteArrayList<>();
        /** Shows that throw before drawing anything. */
        final AtomicInteger failNext = new AtomicInteger();
        List<String> log;

        public void show(NotificationModel.Shown n) {
            if (failNext.getAndUpdate(v -> Math.max(0, v - 1)) > 0) throw new IllegalArgumentException("drawing failed");
            if (log != null) log.add("show:" + n.text);
            shown.add(n);
            active.add(n.tag);
            if (n.tag.startsWith("chat:")) ids.computeIfAbsent(n.tag, t -> new ArrayList<>()).add(n.messageId);
            postedAt.put(n.tag, postClock.getAsLong());
            sentAt.put(n.tag, n.at);
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

        public Map<String, Long> shownAt() {
            return byTag(postedAt);
        }

        public Map<String, Long> shownSentAt() {
            return byTag(sentAt);
        }

        private Map<String, Long> byTag(Map<String, Long> times) {
            Map<String, Long> out = new HashMap<>();
            for (String tag : active) {
                Long at = times.get(tag);
                out.put(tag, at == null ? 0L : at);
            }
            return out;
        }

        /**
         * As ChatNotifier does: the ids kept after the read point stay, re-posted
         * silently as last drawn; none kept cancels; an unchanged stack is left.
         */
        public void trimRead(String tag, long lastMessageId) {
            trims.add(tag + "@" + lastMessageId);
            if (!active.contains(tag)) return;
            List<Long> stack = ids.getOrDefault(tag, Collections.<Long>emptyList());
            List<Long> kept = NotificationModel.keptAfterRead(stack, lastMessageId);
            if (kept.isEmpty()) {
                ids.remove(tag);
                cancel(tag);
                return;
            }
            if (kept.size() == stack.size()) return;
            ids.put(tag, new ArrayList<>(kept));
            List<NotificationModel.Shown> drawn = tagged(tag);
            NotificationModel.Shown again = copy(drawn.get(drawn.size() - 1));
            again.silent = true;
            shown.add(again);
        }

        public void status(HealthSnapshot h) { statuses.add(h); }

        static NotificationModel.Shown copy(NotificationModel.Shown n) {
            NotificationModel.Shown c = new NotificationModel.Shown();
            c.channelId = n.channelId;
            c.groupId = n.groupId;
            c.tag = n.tag;
            c.conversationTitle = n.conversationTitle;
            c.author = n.author;
            c.text = n.text;
            c.publicTitle = n.publicTitle;
            c.openUrl = n.openUrl;
            c.messaging = n.messaging;
            c.privateVisibility = n.privateVisibility;
            c.silent = n.silent;
            c.at = n.at;
            c.configId = n.configId;
            c.discussChannelId = n.discussChannelId;
            c.messageId = n.messageId;
            c.actions = n.actions.clone();
            return c;
        }

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
        /** Run before an expired answer: what the app does meanwhile. */
        volatile Runnable whileExpired;
        final List<RecordedRequest> requests = new CopyOnWriteArrayList<>();
        final List<String> endpoints = new CopyOnWriteArrayList<>();

        @Override
        public MockResponse dispatch(RecordedRequest r) {
            requests.add(r);
            if (expired) {
                Runnable meanwhile = whileExpired;
                if (meanwhile != null) meanwhile.run();
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
    {
        notifier.postClock = () -> now;
    }
    private final HandScheduler scheduler = new HandScheduler();
    /** The engine's hold timer: kept apart from scheduler, whose cancelAll stopRealtime calls. */
    private final HandScheduler holdTimer = new HandScheduler();
    private final SyncKeyValue heldKv = new SyncKeyValue();
    private final HeldStore held = new HeldStore(heldKv, () -> now);
    /** What the engine's Sleeper was asked to wait, ms; each wait moves now forward. */
    private final List<Long> sleeps = new CopyOnWriteArrayList<>();
    private final FakeOdoo odoo = new FakeOdoo();

    /** Calls started on the ntfy client: OkHttp counts a call inside enqueue() or execute(), on the caller's thread. */
    private final AtomicInteger ntfyCalls = new AtomicInteger();

    /** The write ends of the streams pipeEngine answers, in order; closing one ends its stream. */
    private final List<BufferedSink> pipes = new CopyOnWriteArrayList<>();

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
        for (BufferedSink p : pipes) p.close();
        ntfyServer.shutdown();
        odooServer.shutdown();
    }

    // ---- helpers ----

    private PushEngine engine() {
        if (engine == null) engine = newEngine();
        return engine;
    }

    private PushEngine newEngine() {
        return newEngine(null);
    }

    /** An engine whose ntfy calls pass through interceptor first, when one is given. */
    private PushEngine newEngine(Interceptor interceptor) {
        OkHttpClient.Builder b = new OkHttpClient.Builder().eventListener(new EventListener() {
            @Override
            public void callStart(Call call) {
                ntfyCalls.incrementAndGet();
            }
        });
        if (interceptor != null) b.addInterceptor(interceptor);
        OkHttpClient counted = b.build();
        PushEngine e = new PushEngine(store, settings, sessions, new NtfyClient(counted),
                new OdooDirect(new OkHttpClient()), notifier, () -> now, scheduler, held);
        e.setHoldTimer(holdTimer::schedule);
        e.setSleeper(ms -> {
            sleeps.add(ms);
            now += ms;
        });
        return e;
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
        settings.put(level, allowHttp, null, Collections.<String, String>emptyMap(), Arrays.asList(accounts));
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

    /** The level chosen l resolves to on battery, with the default climbing prefs. */
    private static PushLevelPolicy.Effective climbed(int l, boolean wifi, boolean saver, int pct) {
        return PushLevelPolicy.resolve(l, new PushLevelPolicy.PowerState(wifi, false, saver, pct), true,
                BatteryClimber.of(PhonePrefs.DEFAULT));
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
        return rawAt(id, topic, body, NOW / 1000);
    }

    /** raw() stamped by ntfy at timeSec. */
    private static String rawAt(String id, String topic, byte[] body, long timeSec) {
        return "{\"id\":\"" + id + "\",\"time\":" + timeSec + ",\"event\":\"message\",\"topic\":\"" + topic
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

    /**
     * The captured plaintext resource, with the fields of its "erplibre" object (data's for a message) set:
     * a number, a "[...]" JSON array, a "\"...\"" string, or null.
     */
    private static String captured(String name, String... keyValues) throws Exception {
        JSONObject root = new JSONObject(new String(PushPayloadTest.resource(name), StandardCharsets.UTF_8));
        JSONObject e = root.has("erplibre") ? root.getJSONObject("erplibre")
                : root.getJSONObject("options").getJSONObject("data").getJSONObject("erplibre");
        JSONObject data = root.has("options") ? root.getJSONObject("options").getJSONObject("data") : null;
        for (int i = 0; i < keyValues.length; i += 2) {
            String k = keyValues[i];
            String v = keyValues[i + 1];
            Object val = v == null ? JSONObject.NULL
                    : v.startsWith("[") ? new JSONArray(v)
                    : v.startsWith("\"") ? v.substring(1, v.length() - 1)
                    : (Object) Long.valueOf(v);
            if ("res_id".equals(k)) data.put(k, val);
            else e.put(k, val);
        }
        return root.toString();
    }

    private static String encrypted(Subscription sub, String id, String json) throws Exception {
        byte[] body = WebPushTestEncrypt.encrypt(json.getBytes(StandardCharsets.UTF_8), sub.publicKey,
                sub.authSecret, 4096);
        return raw(id, sub.topic, body);
    }

    /** A module 1.5 chat push (captured shape) for channelId carrying messageId. */
    private static String modulePush(Subscription sub, String id, long channelId, long messageId) throws Exception {
        return encrypted(sub, id, captured("push_module_chat.json", "res_id", Long.toString(channelId),
                "message_id", Long.toString(messageId)));
    }

    private static String readPush(Subscription sub, String id, long channelId, long last) throws Exception {
        return encrypted(sub, id, captured("push_read.json", "channel_id", Long.toString(channelId),
                "last_message_id", Long.toString(last)));
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

    @Test
    public void aSessionMirroredDuringTheCheckIsNotMarkedDead() throws Exception {
        mirror(3, true, account("cfg2", "Serveur B"));
        mirrorSession("cfg2", "sid_exemple_secret");
        odoo.expired = true;
        odoo.whileExpired = () -> mirrorSession("cfg2", "sid_exemple_neuf");
        engine().runDue(level(3));
        assertFalse(sessions.expired("cfg2"));
        assertEquals("sid_exemple_neuf", sessions.get("cfg2").sessionId);
        assertTrue(notifier.onChannel("status").isEmpty());
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

    // ---- the effective level in health ----

    @Test
    public void healthReportsTheEffectiveLevelHandedInRealtime() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        PushLevelPolicy.Effective e = climbed(1, true, false, 25);
        assertEquals(PushLevelPolicy.Mode.REALTIME, e.mode);
        engine().setEffective(e);
        engine.startRealtime();
        JSONObject h = engine.health().toJson();
        assertEquals(1, h.getInt("level"));
        assertEquals(2, h.getInt("effectiveLevel"));
        assertEquals("realtime", h.getString("mode"));
        assertEquals("below_one", h.getString("climbReason"));
    }

    @Test
    public void healthCarriesTheClimbReason() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        engine().runDue(climbed(1, false, true, 80));
        JSONObject h = engine.health().toJson();
        assertEquals(3, h.getInt("effectiveLevel"));
        assertEquals("poll_15", h.getString("mode"));
        assertEquals("saver", h.getString("climbReason"));
        engine.runDue(level(1));
        assertTrue(engine.health().toJson().isNull("climbReason"));
    }

    @Test
    public void healthAfterAPowerChangeReportsTheFreshLevelAndReasonWithoutARun() throws Exception {
        mirror(3, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(""));
        engine().runDue(level(3));
        assertEquals(1, ntfyServer.getRequestCount());
        assertEquals(3, engine.health().toJson().getInt("effectiveLevel"));
        engine.setEffective(climbed(3, false, false, 10));
        JSONObject h = engine.health().toJson();
        assertEquals(4, h.getInt("effectiveLevel"));
        assertEquals("poll_60", h.getString("mode"));
        assertEquals("below_two", h.getString("climbReason"));
        assertEquals(1, ntfyServer.getRequestCount());
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
    public void aSessionCopiedInTheSameMillisecondAsTheMirrorIsKept() throws Exception {
        mirror(3, true, account("cfg1", "Serveur A"));
        // an account on its way in: its copy and the mirror that does not name it yet share a millisecond
        sessions.put(new NativeSession("cfg2", odooServer.url("/").toString(), "db_exemple", "sid_exemple_neuf", now));
        engine().onSettingsChanged();
        assertNotNull(sessions.get("cfg2"));
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
                new OdooDirect(new OkHttpClient()), notifier, () -> now, scheduler, held);
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

    // ---- module 1.5 control pushes ----

    @Test
    public void aReadPushTrimsItsConversationAndShowsNothing() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + modulePush(a, "m1", 42, 7)
                + readPush(a, "r1", 42, 7)));
        engine().startRealtime();
        awaitClosed(1);
        assertEquals(1, notifier.shown.size());
        assertEquals(Collections.singletonList("chat:cfg1:42@7"), notifier.trims);
        assertEquals(Collections.singletonList("chat:cfg1:42"), notifier.cancelled);
        assertFalse(notifier.active.contains("chat:cfg1:42"));
        assertEquals("r1", store.cursor(n.url));
    }

    @Test
    public void aReadPushKeepsTheMessagesAfterTheReadPoint() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + modulePush(a, "m1", 42, 7)
                + modulePush(a, "m2", 42, 9) + readPush(a, "r1", 42, 7)));
        engine().startRealtime();
        awaitClosed(1);
        assertEquals(3, notifier.shown.size());
        NotificationModel.Shown again = notifier.shown.get(2);
        assertEquals("chat:cfg1:42", again.tag);
        assertTrue(again.silent);
        assertEquals(Collections.singletonList(9L), notifier.ids.get("chat:cfg1:42"));
        assertTrue(notifier.cancelled.isEmpty());
    }

    @Test
    public void aReadPushAppliesInTheForeground() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        notifier.active.add("chat:cfg1:42");
        notifier.ids.put("chat:cfg1:42", new ArrayList<>(Arrays.asList(5L, 7L)));
        settings.setForeground(true);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + readPush(a, "r1", 42, 7)));
        engine().startRealtime();
        awaitClosed(1);
        assertTrue(notifier.shown.isEmpty());
        assertEquals(Collections.singletonList("chat:cfg1:42"), notifier.cancelled);
    }

    @Test
    public void inboxDoneCancelsTheRecordsNamedSentBeforeIt() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        // the push's ntfy time is 1790000000 s, NOW
        String named = "inbox:cfg1:project.task:1";
        String later = "inbox:cfg1:res.partner:3";
        String other = "inbox:cfg1:project.task:2";
        for (String tag : Arrays.asList(named, later, other, "chat:cfg1:42")) notifier.active.add(tag);
        notifier.sentAt.put(named, NOW - MINUTE);
        notifier.sentAt.put(later, NOW + MINUTE);
        notifier.sentAt.put(other, NOW - MINUTE);
        notifier.sentAt.put("chat:cfg1:42", NOW - MINUTE);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + encrypted(a, "d1",
                captured("push_inbox_done.json", "threads", "[[\"project.task\", 1], [\"res.partner\", 3]]"))));
        engine().startRealtime();
        awaitClosed(1);
        assertEquals(Collections.singletonList(named), notifier.cancelled);
        assertTrue(notifier.shown.isEmpty());
    }

    @Test
    public void inboxDoneNullCancelsEveryInboxNotificationOfTheAccount() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"), account("cfg2", "Serveur B"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        store.subscribe("cfg2", n.url, false);
        List<String> tags = Arrays.asList("inbox:cfg1:project.task:1", "inbox:cfg1:res.partner:3",
                "chat:cfg1:42", "summary:cfg1", "inbox:cfg2:project.task:1");
        for (String tag : tags) {
            notifier.active.add(tag);
            notifier.sentAt.put(tag, NOW - MINUTE);
        }
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + encrypted(a, "d1",
                captured("push_inbox_done.json", "threads", null))));
        engine().startRealtime();
        awaitClosed(1);
        assertEquals(new HashSet<>(Arrays.asList("inbox:cfg1:project.task:1", "inbox:cfg1:res.partner:3")),
                new HashSet<>(notifier.cancelled));
        assertTrue(notifier.shown.isEmpty());
    }

    @Test
    public void aReadPushIsNeverCountedUndecryptable() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)
                + encrypted(a, "r1", new String(PushPayloadTest.resource("push_read.json"), StandardCharsets.UTF_8))
                + encrypted(a, "d1",
                        new String(PushPayloadTest.resource("push_inbox_done.json"), StandardCharsets.UTF_8))));
        engine().startRealtime();
        awaitClosed(1);
        JSONObject h = engine.health().toJson();
        assertEquals(0, h.getInt("undecryptable"));
        assertEquals(0, h.getInt("faults"));
        assertTrue(notifier.shown.isEmpty());
        assertEquals(Collections.singletonList("chat:cfg1:4@23"), notifier.trims);
        assertEquals("d1", store.cursor(n.url));
    }

    @Test
    public void aReadPushTrimsANeverServersNotificationByItsIds() throws Exception {
        mirror(1, true, new AccountView("cfg1", "Serveur A", LockScreenMode.NEVER,
                Collections.singletonMap(42L, new ChannelInfo("Alice Martin", "chat"))));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + modulePush(a, "m1", 42, 7)
                + modulePush(a, "m2", 42, 9) + readPush(a, "r1", 42, 7)));
        engine().startRealtime();
        awaitClosed(1);
        assertEquals(Collections.singletonList(9L), notifier.ids.get("chat:cfg1:42"));
        assertEquals(3, notifier.shown.size());
        NotificationModel.Shown again = notifier.shown.get(2);
        assertTrue(again.silent);
        assertEquals("Nouveau message", again.conversationTitle);
        assertEquals("Nouveau message", again.text);
        assertFalse(again.messaging);
    }

    @Test
    public void inboxDoneCancelsARecordPostedAfterItButSentBefore() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        // a catch-up: the record message and its done arrive together, ten minutes after ntfy stamped them
        now = NOW + 10 * MINUTE;
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)
                + encrypted(a, "m1", new String(PushPayloadTest.resource("push_module_record.json"),
                        StandardCharsets.UTF_8))
                + encrypted(a, "d1", new String(PushPayloadTest.resource("push_inbox_done.json"),
                        StandardCharsets.UTF_8))));
        engine().startRealtime();
        awaitClosed(1);
        assertEquals(1, notifier.shown.size());
        assertEquals(Long.valueOf(NOW + 10 * MINUTE), notifier.postedAt.get("inbox:cfg1:project.task:1"));
        assertEquals(Collections.singletonList("inbox:cfg1:project.task:1"), notifier.cancelled);
    }

    @Test
    public void anUnknownControlPushIsDroppedSilently() throws Exception {
        mirror(1, true, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        notifier.active.add("chat:cfg1:4");
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)
                + encrypted(a, "x1", captured("push_read.json", "type", "\"future\""))
                + encrypted(a, "x2", captured("push_read.json", "v", "2"))));
        engine().startRealtime();
        awaitClosed(1);
        JSONObject h = engine.health().toJson();
        assertEquals(0, h.getInt("undecryptable"));
        assertEquals(0, h.getInt("faults"));
        assertTrue(notifier.shown.isEmpty());
        assertTrue(notifier.trims.isEmpty());
        assertTrue(notifier.cancelled.isEmpty());
        assertEquals("x2", store.cursor(n.url));
    }

    // ---- filter and quiet hours ----

    /** account(configId, label) on a 1.6 server with the given prefs; quiet hours 22:00 to 07:00 when on. */
    private static AccountView withPrefs(String configId, String label, PhoneFilter filter, boolean inbox,
            boolean quietOn, String channelNotifications) {
        return new AccountView(configId, label, LockScreenMode.ALWAYS, account(configId, label).channels, "1.6",
                new AccountView.AccountPrefs(filter, inbox, false, quietOn, 1320, 420, channelNotifications));
    }

    private static String resourceText(String name) throws Exception {
        return new String(PushPayloadTest.resource(name), StandardCharsets.UTF_8);
    }

    /** A LocalTime answering 23:00, inside the quiet hours of withPrefs. */
    private static final PushEngine.LocalTime ELEVEN_PM = epochMs -> 23 * 60;

    @Test
    public void aFilteredPushDrawsNothingAndStillAdvancesTheCursor() throws Exception {
        mirror(1, true, withPrefs("cfg1", "Serveur A", PhoneFilter.NONE, true, false, null));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)
                + encrypted(a, "m1", resourceText("push16_chat.json"))
                + encrypted(a, "m2", resourceText("push16_record.json"))));
        engine().startRealtime();
        awaitClosed(1);
        assertTrue(notifier.shown.isEmpty());
        assertEquals("m2", store.cursor(n.url));
        assertEquals(0, engine.health().toJson().getInt("faults"));
    }

    @Test
    public void aReadPushAppliesOnAServerSetToNothing() throws Exception {
        mirror(1, true, withPrefs("cfg1", "Serveur A", PhoneFilter.NONE, true, false, null));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        notifier.active.add("chat:cfg1:42");
        notifier.ids.put("chat:cfg1:42", new ArrayList<>(Arrays.asList(5L, 7L)));
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + readPush(a, "r1", 42, 7)));
        engine().startRealtime();
        awaitClosed(1);
        assertEquals(Collections.singletonList("chat:cfg1:42"), notifier.cancelled);
        assertTrue(notifier.shown.isEmpty());
    }

    @Test
    public void insideQuietHoursTheNotificationIsPostedSilently() throws Exception {
        mirror(1, true, withPrefs("cfg1", "Serveur A", PhoneFilter.ALL, true, true, null));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)
                + encrypted(a, "m1", resourceText("push16_chat.json"))));
        engine().setLocalTime(ELEVEN_PM);
        engine.startRealtime();
        awaitClosed(1);
        assertEquals(1, notifier.shown.size());
        assertEquals("chat:cfg1:4", notifier.shown.get(0).tag);
        assertTrue(notifier.shown.get(0).silent);
    }

    @Test
    public void anInboxNotificationInsideQuietHoursIsPostedSilently() throws Exception {
        mirror(1, true, withPrefs("cfg1", "Serveur A", PhoneFilter.ALL, true, true, null));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)
                + encrypted(a, "m1", resourceText("push16_record.json"))));
        engine().setLocalTime(ELEVEN_PM);
        engine.startRealtime();
        awaitClosed(1);
        assertEquals(1, notifier.shown.size());
        assertEquals("inbox:cfg1:project.task:1", notifier.shown.get(0).tag);
        assertTrue(notifier.shown.get(0).silent);
    }

    @Test
    public void theZoneIsReadAtEachPost() throws Exception {
        mirror(1, true, withPrefs("cfg1", "Serveur A", PhoneFilter.ALL, true, true, null));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)
                + encrypted(a, "m1", resourceText("push16_chat.json"))
                + encrypted(a, "m2", resourceText("push16_group.json"))));
        // the zone changes between the two posts: 00:30 there, 10:00 here
        int[] answers = {30, 600};
        List<Long> asked = new CopyOnWriteArrayList<>();
        engine().setLocalTime(epochMs -> {
            asked.add(epochMs);
            return answers[Math.min(asked.size(), answers.length) - 1];
        });
        engine.startRealtime();
        awaitClosed(1);
        assertEquals(2, notifier.shown.size());
        assertTrue(notifier.shown.get(0).silent);
        assertFalse(notifier.shown.get(1).silent);
        assertEquals(Arrays.asList(NOW, NOW), asked);
    }

    @Test
    public void aServerSetToNothingGetsNoSummary() throws Exception {
        mirror(3, true, withPrefs("cfg2", "Serveur B", PhoneFilter.ALL, true, false, null));
        mirrorSession("cfg2", "sid_exemple_secret");
        odoo.mailData = mailData(3);
        engine().runDue(level(3));
        assertEquals(1, notifier.tagged("summary:cfg2").size());
        mirror(3, true, withPrefs("cfg2", "Serveur B", PhoneFilter.NONE, true, false, null));
        odoo.mailData = mailData(5);
        engine.runDue(level(3));
        assertEquals(1, notifier.tagged("summary:cfg2").size());
        assertTrue(notifier.cancelled.contains("summary:cfg2"));
        assertFalse(notifier.active.contains("summary:cfg2"));
    }

    @Test
    public void inboxOffLeavesTheInboxShareOutOfTheSummary() throws Exception {
        mirror(3, true, withPrefs("cfg2", "Serveur B", PhoneFilter.ALL, false, false, null));
        mirrorSession("cfg2", "sid_exemple_secret");
        // conversations 10, inbox share 2 (UnreadSummaryTest)
        odoo.mailData = resourceText("mail_data_counters.json");
        engine().runDue(level(3));
        List<NotificationModel.Shown> s = notifier.tagged("summary:cfg2");
        assertEquals(1, s.size());
        assertTrue(s.get(0).publicTitle, s.get(0).publicTitle.startsWith("10 "));
    }

    @Test
    public void theSummaryInsideQuietHoursIsSilent() throws Exception {
        mirror(3, true, withPrefs("cfg2", "Serveur B", PhoneFilter.ALL, true, true, null));
        mirrorSession("cfg2", "sid_exemple_secret");
        odoo.mailData = mailData(3);
        engine().setLocalTime(ELEVEN_PM);
        engine.runDue(level(3));
        List<NotificationModel.Shown> s = notifier.tagged("summary:cfg2");
        assertEquals(1, s.size());
        assertTrue(s.get(0).silent);
    }

    @Test
    public void theGeneralChannelSettingReachesTheSummary() throws Exception {
        mirror(3, true, withPrefs("cfg2", "Serveur B", PhoneFilter.ALL, true, false, "no_notif"));
        mirrorSession("cfg2", "sid_exemple_secret");
        // 12 less the 3 mentions of channel 4, a default channel the general « no_notif » silences
        odoo.mailData = resourceText("mail_data_counters.json");
        engine().runDue(level(3));
        List<NotificationModel.Shown> s = notifier.tagged("summary:cfg2");
        assertEquals(1, s.size());
        assertTrue(s.get(0).publicTitle, s.get(0).publicTitle.startsWith("9 "));
    }

    @Test
    public void aRecordMentionPassesWithTheInboxOffWhenRecordMentionsRing() throws Exception {
        mirror(1, true, new AccountView("cfg1", "Serveur A", LockScreenMode.ALWAYS,
                account("cfg1", "Serveur A").channels, "1.6",
                new AccountView.AccountPrefs(PhoneFilter.ALL, false, true, false, 1320, 420, null)));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)
                + encrypted(a, "m1", resourceText("push16_record.json"))
                + encrypted(a, "m2", resourceText("push16_record_mention.json"))));
        engine().startRealtime();
        awaitClosed(1);
        assertEquals(1, notifier.shown.size());
        assertEquals("inbox:cfg1:project.task:1", notifier.shown.get(0).tag);
        assertTrue(notifier.shown.get(0).text, notifier.shown.get(0).text.contains("la date te convient"));
    }

    // ---- the browser-active hold ----

    /** The mirror at level with the phone's browser mode. */
    private void mirrorMode(int level, BrowserMode mode, AccountView... accounts) {
        settings.put(level, true, new PhonePrefs(true, 30, 15, mode), Collections.<String, String>emptyMap(),
                Arrays.asList(accounts));
    }

    /** The captured chat push of conversation 4, message 26, sent while a browser was online. */
    private static String chatOnline(Subscription sub, String id) throws Exception {
        return encrypted(sub, id, resourceText("push16_chat_browser_online.json"));
    }

    /** The captured group push of conversation 3, message 27, sent while a browser was online. */
    private static String groupOnline(Subscription sub, String id) throws Exception {
        return encrypted(sub, id, resourceText("push16_group_browser_online.json"));
    }

    /** groupOnline stamped by ntfy at timeSec. */
    private static String groupOnlineAt(Subscription sub, String id, long timeSec) throws Exception {
        byte[] body = WebPushTestEncrypt.encrypt(PushPayloadTest.resource("push16_group_browser_online.json"),
                sub.publicKey, sub.authSecret, 4096);
        return rawAt(id, sub.topic, body, timeSec);
    }

    /** Runs and removes the scheduler's tasks due at once, leaving the delayed ones. */
    private void runImmediate() {
        List<HandScheduler.Task> now0 = immediate();
        scheduler.tasks.removeAll(now0);
        for (HandScheduler.Task t : now0) t.r.run();
    }

    /**
     * One stream carrying lines after its open and kept open (the body promises
     * more than it sends): returns once its last line is handled and the
     * engine's monitor is free again.
     */
    private void streamOpen(Subscription a, String lines) throws Exception {
        String[] sent = lines.trim().split("\n");
        String last = new JSONObject(sent[sent.length - 1]).getString("id");
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + lines).setHeader("Content-Length", "100000"));
        engine().startRealtime();
        await(() -> last.equals(store.cursor(a.ntfyUrl)), "the stream's last line");
        engine.health();
    }

    /**
     * An engine whose streams are answered by pipes the test writes (pipes,
     * in order) while its polls reach ntfyServer: a stream ends exactly when
     * the test closes its pipe.
     */
    private PushEngine pipeEngine() {
        return newEngine(chain -> {
            if (chain.request().url().queryParameter("poll") != null) return chain.proceed(chain.request());
            Pipe pipe = new Pipe(1 << 16);
            pipes.add(Okio.buffer(pipe.sink()));
            return new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200)
                    .message("OK").body(ResponseBody.create(Okio.buffer(pipe.source()),
                            MediaType.get("application/x-ndjson"), -1)).build();
        });
    }

    /** Writes lines to the index-th stream pipeEngine opened. */
    private void pipeWrite(int index, String lines) throws Exception {
        await(() -> pipes.size() > index, "stream " + index);
        BufferedSink sink = pipes.get(index);
        sink.writeUtf8(lines);
        sink.flush();
    }

    /**
     * A job whose wait is cut short by the death of the process: the polled
     * messages stay held in the store, their seen ids and cursor saved.
     */
    private void dieWhileAPollWaits(String pollBody) throws Exception {
        ntfyServer.enqueue(new MockResponse().setBody(pollBody));
        PushEngine dying = newEngine();
        dying.setSleeper(ms -> {
            throw new IllegalStateException("process killed");
        });
        try {
            dying.runDue(level(3));
            throw new AssertionError("the job was expected to wait");
        } catch (IllegalStateException expected) {
            // the process died inside the wait
        }
        holdTimer.tasks.clear();
    }

    @Test
    public void waitHoldsAPushWhoseBrowserIsOnline() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        streamOpen(a, chatOnline(a, "m1"));
        assertTrue(notifier.shown.isEmpty());
        assertEquals(1, held.of(n.url).size());
        assertEquals(26L, held.of(n.url).get(0).messageId);
        assertEquals(4L, held.of(n.url).get(0).channelId);
        assertEquals(1, holdTimer.tasks.size());
        assertEquals(PushEngine.HOLD_MS, holdTimer.last().delay);
        assertEquals("m1", store.cursor(n.url));
    }

    @Test
    public void aReadPushWithinTheWaitDropsTheHeldPush() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        streamOpen(a, chatOnline(a, "m1") + readPush(a, "r1", 4, 26));
        assertTrue(held.isEmpty());
        now += PushEngine.HOLD_MS;
        holdTimer.runAll();
        assertTrue(notifier.shown.isEmpty());
    }

    @Test
    public void aHeldPushIsDrawnWhenDue() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        streamOpen(a, chatOnline(a, "m1"));
        now += PushEngine.HOLD_MS - 1;
        holdTimer.runAll();
        assertTrue(notifier.shown.isEmpty());
        now += 1;
        holdTimer.runAll();
        assertEquals(1, notifier.shown.size());
        NotificationModel.Shown s = notifier.shown.get(0);
        assertEquals("chat:cfg1:4", s.tag);
        assertEquals(26L, s.messageId);
        assertEquals(NOW, s.at);
        assertFalse(s.silent);
        assertTrue(held.isEmpty());
    }

    @Test
    public void aPushWithoutBrowserOnlineRingsAtOnce() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        streamOpen(a, encrypted(a, "m1", resourceText("push16_chat.json")));
        assertEquals(1, notifier.shown.size());
        assertTrue(held.isEmpty());
        assertTrue(holdTimer.tasks.isEmpty());
    }

    @Test
    public void ringModeNeverHolds() throws Exception {
        mirrorMode(1, BrowserMode.RING, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        streamOpen(a, chatOnline(a, "m1"));
        assertEquals(1, notifier.shown.size());
        assertTrue(held.isEmpty());
        assertTrue(holdTimer.tasks.isEmpty());
    }

    @Test
    public void aQuietPhoneHoldsAPushTheServerStillSent() throws Exception {
        mirrorMode(1, BrowserMode.QUIET, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        streamOpen(a, chatOnline(a, "m1"));
        assertTrue(notifier.shown.isEmpty());
        assertEquals(1, held.of(n.url).size());
        now += PushEngine.HOLD_MS;
        holdTimer.runAll();
        assertEquals(1, notifier.shown.size());
    }

    @Test
    public void aPushWithoutThe16FlagsRingsAtOnce() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        streamOpen(a, modulePush(a, "m1", 4, 26) + encrypted(a, "m2", resourceText("push16_v1_device.json")));
        assertEquals(2, notifier.shown.size());
        assertTrue(held.isEmpty());
    }

    @Test
    public void stopRealtimeDoesNotDropAHeldPush() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        streamOpen(a, chatOnline(a, "m1"));
        engine.stopRealtime();
        assertTrue(scheduler.tasks.isEmpty());
        assertEquals(1, holdTimer.tasks.size());
        // the stream gone, nothing caught up since: the timer draws nothing and keeps the entry
        now += PushEngine.HOLD_MS;
        holdTimer.runAll();
        assertTrue(notifier.shown.isEmpty());
        assertEquals(1, held.of(n.url).size());

        // the run that follows polls the server holding it, even within the hour, and draws it
        settings.setEngineState("poll:" + n.url, Long.toString(now - MINUTE));
        ntfyServer.enqueue(new MockResponse().setBody(""));
        engine.runDue(level(4));
        assertTrue(sleeps.isEmpty());
        assertEquals(1, notifier.shown.size());
        assertTrue(held.isEmpty());
    }

    @Test
    public void aStreamRestartedInsideTheHoldDrawsOnlyAfterItsCatchUp() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        streamOpen(a, chatOnline(a, "m1"));
        engine.stopRealtime();
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)).setHeader("Content-Length", "100000"));
        ntfyServer.enqueue(new MockResponse().setBody(""));
        engine.startRealtime();
        await(() -> !immediate().isEmpty(), "the new stream's catch-up");
        now += PushEngine.HOLD_MS;
        holdTimer.runAll();
        assertTrue(notifier.shown.isEmpty());

        runImmediate();
        assertEquals(1, notifier.shown.size());
        assertEquals("chat:cfg1:4", notifier.shown.get(0).tag);
        assertTrue(held.isEmpty());
    }

    /**
     * Holds m1 on a live stream, then subscribes cfg2 on the same ntfy: the
     * changed topics reopen the stream, the hold timer fires before the new
     * stream's catch-up and draws nothing, then that catch-up answers pollBody.
     */
    private void holdThenReopen(Subscription a, String pollBody) throws Exception {
        streamOpen(a, chatOnline(a, "m1"));
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)).setHeader("Content-Length", "100000"));
        ntfyServer.enqueue(new MockResponse().setBody(pollBody));
        store.subscribe("cfg2", a.ntfyUrl, false);
        engine.onStoresChanged();
        await(() -> !immediate().isEmpty(), "the reopened stream's catch-up");
        now += PushEngine.HOLD_MS;
        holdTimer.runAll();
        assertTrue(notifier.shown.isEmpty());
        assertEquals(1, held.of(a.ntfyUrl).size());
        runImmediate();
    }

    @Test
    public void aReopenedStreamWhoseCatchUpBringsTheReadDrawsNothing() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"), account("cfg2", "Serveur B"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        holdThenReopen(a, readPush(a, "r1", 4, 26));
        assertTrue(held.isEmpty());
        holdTimer.runAll();
        assertTrue(notifier.shown.isEmpty());
    }

    @Test
    public void aReopenedStreamDrawsTheHeldPushAfterItsCatchUp() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"), account("cfg2", "Serveur B"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        holdThenReopen(a, "");
        assertEquals(1, notifier.shown.size());
        assertEquals("chat:cfg1:4", notifier.shown.get(0).tag);
        assertTrue(held.isEmpty());
    }

    @Test
    public void theHoldTakesItsOwnWakelockAndALaterMessageDoesNotShortenIt() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        List<String> hold = new CopyOnWriteArrayList<>();
        List<String> message = new CopyOnWriteArrayList<>();
        engine().setHoldWake(new PushEngine.Wake() {
            public void acquire() { hold.add("acquire"); }
            public void acquire(long timeoutMs) { hold.add("acquire:" + timeoutMs); }
            public void release() { hold.add("release"); }
        });
        engine.setWake(new PushEngine.Wake() {
            public void acquire() { message.add("acquire"); }
            public void release() { message.add("release"); }
        });
        // a held chat, a push that rings at once, then a held group due at the same time
        streamOpen(a, chatOnline(a, "m1") + encrypted(a, "m2", resourceText("push16_chat.json"))
                + groupOnline(a, "m3"));
        assertEquals(Collections.singletonList("acquire:" + (PushEngine.HOLD_MS + 2_000)), hold);
        // the message wakelock is let go after the monitor
        await(() -> message.size() == 6, "three message wakelock pairs");
        assertEquals(1, notifier.shown.size());
        now += PushEngine.HOLD_MS;
        holdTimer.runAll();
        assertEquals(3, notifier.shown.size());
        assertEquals(Arrays.asList("acquire:" + (PushEngine.HOLD_MS + 2_000), "release"), hold);
    }

    @Test
    public void aPolledMessageIsDueFromItsNtfyTimeClampedToTheHold() throws Exception {
        mirrorMode(3, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        // stamped 4 s ago: due in 6 s
        now = NOW + 4_000;
        ntfyServer.enqueue(new MockResponse().setBody(chatOnline(a, "m1")));
        ntfyServer.enqueue(new MockResponse().setBody(""));
        engine().runDue(level(3));
        assertEquals(Collections.singletonList(6_000L), sleeps);
        assertEquals(1, notifier.shown.size());
        // stamped a minute ago: due at once, no wait and no second poll
        now = NOW + MINUTE;
        ntfyServer.enqueue(new MockResponse().setBody(chatOnline(a, "m2")));
        engine.runDue(level(3));
        assertEquals(1, sleeps.size());
        assertEquals(2, notifier.shown.size());
        assertEquals(3, ntfyServer.getRequestCount());
        // stamped a minute ahead of this clock: held HOLD_MS, not longer
        now = NOW - MINUTE;
        ntfyServer.enqueue(new MockResponse().setBody(chatOnline(a, "m3")));
        ntfyServer.enqueue(new MockResponse().setBody(""));
        engine.runDue(level(3));
        assertEquals(Arrays.asList(6_000L, PushEngine.HOLD_MS), sleeps);
        assertEquals(3, notifier.shown.size());
        assertTrue(held.isEmpty());
    }

    @Test
    public void aHeldMessageSurvivesARestartAndIsDrawnWhenDue() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        // polled 6 s after NOW: m1 stamped at NOW is due at NOW + 10 s, m2 stamped at NOW + 6 s at NOW + 16 s
        now = NOW + 6_000;
        dieWhileAPollWaits(chatOnline(a, "m1") + groupOnlineAt(a, "m2", NOW / 1000 + 6));
        assertEquals(2, held.of(n.url).size());
        assertTrue(notifier.shown.isEmpty());

        // a new process at NOW + 12 s: nothing at construction nor at the stream's open, until the catch-up
        now = NOW + 12_000;
        engine = newEngine();
        assertTrue(notifier.shown.isEmpty());
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)).setHeader("Content-Length", "100000"));
        ntfyServer.enqueue(new MockResponse().setBody(""));
        engine.startRealtime();
        await(() -> !immediate().isEmpty(), "the catch-up");
        assertTrue(notifier.shown.isEmpty());
        assertTrue(holdTimer.tasks.isEmpty());
        runImmediate();
        RecordedRequest catchUp = null;
        for (int i = 0; i < 3; i++) catchUp = ntfyServer.takeRequest();
        assertTrue(catchUp.getPath(), catchUp.getPath().contains("poll=1"));
        assertTrue(catchUp.getPath(), catchUp.getPath().endsWith("since=m2"));
        assertEquals(1, notifier.shown.size());
        assertEquals("chat:cfg1:4", notifier.shown.get(0).tag);
        assertEquals(1, holdTimer.tasks.size());
        assertEquals(4_000L, holdTimer.last().delay);

        now = NOW + 16_000;
        holdTimer.runAll();
        assertEquals(2, notifier.shown.size());
        assertEquals("chat:cfg1:3", notifier.shown.get(1).tag);
        assertTrue(held.isEmpty());
    }

    @Test
    public void aFailedCatchUpIsRetriedWithTheBackoffAndThenReleases() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        dieWhileAPollWaits(chatOnline(a, "m1"));
        assertEquals(1, held.of(n.url).size());

        // a new process: the stream holds m2 live and stays up, the catch-up poll fails
        now = NOW + MINUTE;
        engine = newEngine();
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + groupOnline(a, "m2"))
                .setHeader("Content-Length", "100000"));
        ntfyServer.enqueue(new MockResponse().setResponseCode(503));
        engine.startRealtime();
        await(() -> held.of(n.url).size() == 2 && !immediate().isEmpty(), "the live hold and the catch-up");
        runImmediate();
        now += PushEngine.HOLD_MS;
        holdTimer.runAll();
        assertTrue(notifier.shown.isEmpty());

        // the catch-up's retry, on the backoff's first wait
        assertEquals(1, scheduler.tasks.size());
        long first = PushEngine.RECONNECT_MS[0];
        inRange(scheduler.last().delay, first, first + (long) (first * PushEngine.JITTER));
        ntfyServer.enqueue(new MockResponse().setBody(""));
        scheduler.runAll();
        assertEquals(2, notifier.shown.size());
        assertEquals("chat:cfg1:4", notifier.shown.get(0).tag);
        assertEquals("chat:cfg1:3", notifier.shown.get(1).tag);
        assertTrue(held.isEmpty());
    }

    @Test
    public void aReadPushReplayedAtRestartDropsTheHeldMessage() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        dieWhileAPollWaits(chatOnline(a, "m1"));
        assertEquals(1, held.of(n.url).size());

        now = NOW + MINUTE;
        engine = newEngine();
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)).setHeader("Content-Length", "100000"));
        ntfyServer.enqueue(new MockResponse().setBody(readPush(a, "r1", 4, 26)));
        engine.startRealtime();
        await(() -> !immediate().isEmpty(), "the catch-up");
        runImmediate();
        assertTrue(held.isEmpty());
        holdTimer.runAll();
        assertTrue(notifier.shown.isEmpty());
    }

    @Test
    public void aReleasedMessageIsNotDrawnTwiceAfterAReplay() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        // held by a process that died before its seen ids and cursor were saved
        String m1 = chatOnline(a, "m1");
        held.add(n.url, NtfyMessage.parse(m1.trim()), "cfg1", 4, 26, NOW + PushEngine.HOLD_MS);
        now = NOW + MINUTE;
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)).setHeader("Content-Length", "100000"));
        ntfyServer.enqueue(new MockResponse().setBody(""));
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + m1));
        engine().startRealtime();
        await(() -> !immediate().isEmpty(), "the catch-up");
        runImmediate();
        assertEquals(1, notifier.shown.size());
        assertFalse(store.seen(n.url).add("m1"));

        // a new process: the stream replays m1
        engine.stopRealtime();
        engine = newEngine();
        engine.startRealtime();
        awaitClosed(1);
        assertEquals(1, notifier.tagged("chat:cfg1:4").size());
        assertEquals(1, notifier.shown.size());
    }

    @Test
    public void aHeldEntryThatCannotBeDecryptedAtReleaseIsCounted() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        streamOpen(a, chatOnline(a, "m1"));
        // the key changed meanwhile
        JSONObject rec = new JSONObject(storeKv.get("sub:cfg1"));
        rec.put("priv", "v1:AAAAAAAAAAAAAAAA:AAAA");
        storeKv.put("sub:cfg1", rec.toString());
        now += PushEngine.HOLD_MS;
        holdTimer.runAll();
        assertTrue(notifier.shown.isEmpty());
        assertTrue(held.isEmpty());
        JSONObject h = engine.health().toJson();
        assertEquals(1, h.getInt("heldLost"));
        assertEquals(0, h.getInt("undecryptable"));
    }

    @Test
    public void aHeldMessageOfAnAccountNoLongerSubscribedIsCounted() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        streamOpen(a, chatOnline(a, "m1"));
        // no catch-up comes for a server without subscriptions: its entry goes at once
        store.unsubscribe("cfg1");
        engine.onStoresChanged();
        assertTrue(held.isEmpty());
        assertTrue(notifier.shown.isEmpty());
        assertEquals(1, engine.health().toJson().getInt("heldLost"));
    }

    /** A hold wakelock that records its calls in calls. */
    private static PushEngine.Wake recordingWake(List<String> calls) {
        return new PushEngine.Wake() {
            public void acquire() { calls.add("acquire"); }
            public void acquire(long timeoutMs) { calls.add("acquire:" + timeoutMs); }
            public void release() { calls.add("release"); }
        };
    }

    @Test
    public void aDeliberateUnsubscribeDropsTheHeldPushUncounted() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        List<String> hold = new CopyOnWriteArrayList<>();
        engine().setHoldWake(recordingWake(hold));
        streamOpen(a, chatOnline(a, "m1"));
        ChatPushRuntime.unsubscribe(engine, store, sessions, "cfg1", null);
        assertTrue(held.isEmpty());
        now += PushEngine.HOLD_MS;
        holdTimer.runAll();
        assertTrue(notifier.shown.isEmpty());
        assertEquals(0, engine.health().toJson().getInt("heldLost"));
        assertEquals(Arrays.asList("acquire:" + (PushEngine.HOLD_MS + 2_000), "release"), hold);
    }

    @Test
    public void aMoveToOffDropsTheHeldPushAndItsReturnDrawsNothing() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        List<String> hold = new CopyOnWriteArrayList<>();
        engine().setHoldWake(recordingWake(hold));
        streamOpen(a, chatOnline(a, "m1"));
        mirrorMode(5, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        engine.onSettingsChanged();
        assertTrue(held.isEmpty());
        assertEquals(Arrays.asList("acquire:" + (PushEngine.HOLD_MS + 2_000), "release"), hold);
        engine.stopRealtime();

        // level 1 again: nothing held, so the reopened stream needs no catch-up and the timer draws nothing
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        engine.onSettingsChanged();
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)).setHeader("Content-Length", "100000"));
        engine.startRealtime();
        await(() -> "connected".equals(state(n.url)), "the reopened stream");
        assertTrue(immediate().isEmpty());
        now += PushEngine.HOLD_MS;
        holdTimer.runAll();
        assertTrue(notifier.shown.isEmpty());
        assertEquals(0, engine.health().toJson().getInt("heldLost"));
    }

    @Test
    public void runDueAtOffDropsHeldEntries() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        streamOpen(a, chatOnline(a, "m1"));
        engine.stopRealtime();
        engine.runDue(level(5));
        assertTrue(held.isEmpty());
        now += PushEngine.HOLD_MS;
        holdTimer.runAll();
        assertTrue(notifier.shown.isEmpty());
        assertEquals(0, engine.health().toJson().getInt("heldLost"));
    }

    @Test
    public void anEngineBuiltAtOffDropsWhatAnEarlierProcessHeld() throws Exception {
        mirrorMode(3, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        dieWhileAPollWaits(chatOnline(a, "m1"));
        assertEquals(1, held.of(n.url).size());
        // level 5 mirrored, then the process died before onSettingsChanged
        mirrorMode(5, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        engine = newEngine();
        assertTrue(held.isEmpty());
        assertTrue(notifier.shown.isEmpty());
        assertEquals(0, engine.health().toJson().getInt("heldLost"));
    }

    @Test
    public void aPollBatchDropsAMessageWhoseReadFollowsInTheBatch() throws Exception {
        mirrorMode(3, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(chatOnline(a, "m1") + readPush(a, "r1", 4, 26)));
        engine().runDue(level(3));
        assertTrue(notifier.shown.isEmpty());
        assertTrue(sleeps.isEmpty());
        assertTrue(held.isEmpty());
        assertEquals(1, ntfyServer.getRequestCount());
    }

    @Test
    public void aFreshMessageInAPollIsWaitedForAndPolledOnceMore() throws Exception {
        mirrorMode(3, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(chatOnline(a, "m1")));
        ntfyServer.enqueue(new MockResponse().setBody(readPush(a, "r1", 4, 26)));
        engine().runDue(level(3));
        assertEquals(Collections.singletonList(PushEngine.HOLD_MS), sleeps);
        assertEquals(2, ntfyServer.getRequestCount());
        ntfyServer.takeRequest();
        assertTrue(ntfyServer.takeRequest().getPath().endsWith("since=m1"));
        assertTrue(notifier.shown.isEmpty());
        assertTrue(held.isEmpty());
    }

    @Test
    public void entriesStillFreshAfterTheSecondPollAreReleasedBeforeTheJobEnds() throws Exception {
        mirrorMode(3, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(chatOnline(a, "m1")));
        ntfyServer.enqueue(new MockResponse().setBody(groupOnline(a, "m2")));
        engine().runDue(level(3));
        assertEquals(1, sleeps.size());
        assertEquals(2, ntfyServer.getRequestCount());
        assertEquals(2, notifier.shown.size());
        assertEquals("chat:cfg1:3", notifier.shown.get(1).tag);
        assertTrue(held.isEmpty());
    }

    @Test
    public void aHeldPushReleasedInTheForegroundDrawsNothing() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        streamOpen(a, chatOnline(a, "m1"));
        settings.setForeground(true);
        now += PushEngine.HOLD_MS;
        holdTimer.runAll();
        assertTrue(notifier.shown.isEmpty());
        assertTrue(held.isEmpty());
        assertEquals(0, engine.health().toJson().getInt("heldLost"));
    }

    /**
     * The stream's reconnect opens and stays open, then its catch-up poll
     * answers pollBody: returns once that catch-up ran.
     */
    private void reconnectAndCatchUp(Subscription a, String pollBody) throws Exception {
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic)).setHeader("Content-Length", "100000"));
        ntfyServer.enqueue(new MockResponse().setBody(pollBody));
        scheduler.runAll();
        await(() -> !immediate().isEmpty(), "the reconnect's catch-up");
        runImmediate();
    }

    @Test
    public void aStreamDroppedInsideTheHoldReleasesNothingBeforeItsReconnectCatchesUp() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        // the stream holds m1 and drops: the read push is published while it is down
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + chatOnline(a, "m1")));
        engine().startRealtime();
        awaitClosed(1);
        now += PushEngine.HOLD_MS;
        holdTimer.runAll();
        assertTrue(notifier.shown.isEmpty());
        assertEquals(1, held.of(n.url).size());

        reconnectAndCatchUp(a, readPush(a, "r1", 4, 26));
        assertTrue(held.isEmpty());
        holdTimer.runAll();
        assertTrue(notifier.shown.isEmpty());
    }

    @Test
    public void aStreamDroppedInsideTheHoldDrawsAfterItsReconnectCatchesUp() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        ntfyServer.enqueue(new MockResponse().setBody(open(a.topic) + chatOnline(a, "m1")));
        engine().startRealtime();
        awaitClosed(1);
        now += PushEngine.HOLD_MS;
        holdTimer.runAll();
        assertTrue(notifier.shown.isEmpty());

        reconnectAndCatchUp(a, "");
        assertEquals(1, notifier.shown.size());
        assertEquals("chat:cfg1:4", notifier.shown.get(0).tag);
        assertTrue(held.isEmpty());
    }

    @Test
    public void aHeldEntryOfANtfyRemovedWhileTheProcessWasDeadIsCounted() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        // held by an earlier process on a server since removed with its subscription
        store.putNtfy(new NtfyServer("https://ntfy.exemple.test/", TOKEN, PREFIX, CACHE));
        Subscription b = store.subscribe("cfg2", "https://ntfy.exemple.test/", false);
        held.add(b.ntfyUrl, NtfyMessage.parse(chatOnline(b, "g1").trim()), "cfg2", 4, 26, NOW + PushEngine.HOLD_MS);
        store.unsubscribe("cfg2");
        store.removeNtfy(b.ntfyUrl);

        List<String> hold = new CopyOnWriteArrayList<>();
        engine = newEngine();
        engine.setHoldWake(new PushEngine.Wake() {
            public void acquire() { hold.add("acquire"); }
            public void acquire(long timeoutMs) { hold.add("acquire:" + timeoutMs); }
            public void release() { hold.add("release"); }
        });
        // the constructor releases nothing, not even an entry no catch-up can come for
        assertEquals(Collections.singleton(b.ntfyUrl), held.linkUrls());
        assertEquals(0, engine.health().toJson().getInt("heldLost"));

        // the first start releases it, once the engine is set up: unreadable, counted; then the live hold read
        streamOpen(a, chatOnline(a, "m1") + readPush(a, "r1", 4, 26));
        assertTrue(held.isEmpty());
        assertTrue(notifier.shown.isEmpty());
        assertEquals(1, engine.health().toJson().getInt("heldLost"));
        // nothing stale keeps the hold's wakelock
        assertEquals(Arrays.asList("acquire:" + (PushEngine.HOLD_MS + 2_000), "release"), hold);
    }

    @Test
    public void anUnreadableHeldEntryIsCounted() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        store.subscribe("cfg1", n.url, false);
        heldKv.put("held:m1", "{\"link\":");
        // the first sync after construction reads the store
        engine().onStoresChanged();
        assertEquals(1, engine.health().toJson().getInt("heldLost"));
        assertTrue(heldKv.map.isEmpty());
        assertEquals(1, engine.health().toJson().getInt("heldLost"));
    }

    @Test
    public void aPollingRunWhileAStreamIsUpLeavesTheStreamsFreshHoldToTheTimer() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        String m1 = chatOnline(a, "m1");
        String m2 = groupOnline(a, "m2");
        String r2 = readPush(a, "r2", 3, 27);
        CountDownLatch streamGate = new CountDownLatch(1);
        AtomicInteger polls = new AtomicInteger();
        ntfyServer.setDispatcher(new Dispatcher() {
            @Override
            public MockResponse dispatch(RecordedRequest r) throws InterruptedException {
                if (!r.getPath().contains("poll=1")) {
                    // the stream answers once the run waits
                    streamGate.await(5, TimeUnit.SECONDS);
                    return new MockResponse().setBody(open(a.topic) + m2).setHeader("Content-Length", "100000");
                }
                switch (polls.incrementAndGet()) {
                    case 1: return new MockResponse().setBody(m1);
                    case 2: return new MockResponse().setBody("");
                    default: return new MockResponse().setBody(r2);
                }
            }
        });
        engine().startRealtime();
        // the run's wait: the stream holds m2, due HOLD_MS after it
        engine.setSleeper(ms -> {
            sleeps.add(ms);
            now += ms;
            streamGate.countDown();
            await(() -> held.of(n.url).size() == 2, "the stream's hold");
        });
        // a level the job reads as a poll while the service has not closed the stream yet
        engine.runDue(level(3));
        assertEquals(Collections.singletonList(PushEngine.HOLD_MS), sleeps);
        assertEquals(1, notifier.shown.size());
        assertEquals("chat:cfg1:4", notifier.shown.get(0).tag);
        assertEquals(1, held.of(n.url).size());
        assertEquals(27L, held.of(n.url).get(0).messageId);

        // the stream's catch-up brings m2's read: never drawn
        runImmediate();
        assertTrue(held.isEmpty());
        now += PushEngine.HOLD_MS;
        holdTimer.runAll();
        assertEquals(1, notifier.shown.size());
    }

    @Test
    public void aCatchUpEndingAfterItsStreamClosedReleasesNothing() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        dieWhileAPollWaits(chatOnline(a, "m1"));

        // a new process: the stream holds m2 live; its catch-up poll is answered once the stream has closed
        now = NOW + MINUTE;
        CountDownLatch pollArrived = new CountDownLatch(1);
        CountDownLatch answer = new CountDownLatch(1);
        ntfyServer.setDispatcher(new Dispatcher() {
            @Override
            public MockResponse dispatch(RecordedRequest r) throws InterruptedException {
                pollArrived.countDown();
                answer.await(5, TimeUnit.SECONDS);
                return new MockResponse().setBody("");
            }
        });
        engine = pipeEngine();
        engine.startRealtime();
        pipeWrite(0, open(a.topic) + groupOnline(a, "m2"));
        await(() -> held.of(n.url).size() == 2 && !immediate().isEmpty(), "the live hold and the catch-up");
        Thread catchUp = new Thread(this::runImmediate);
        catchUp.start();
        assertTrue(pollArrived.await(5, TimeUnit.SECONDS));
        pipes.get(0).close();
        awaitClosed(1);
        answer.countDown();
        catchUp.join(5000);
        assertFalse(catchUp.isAlive());
        assertTrue(notifier.shown.isEmpty());
        now += PushEngine.HOLD_MS;
        holdTimer.runAll();
        assertTrue(notifier.shown.isEmpty());
        assertEquals(2, held.of(n.url).size());

        // the reconnect's own catch-up draws both
        scheduler.runAll();
        pipeWrite(1, open(a.topic));
        await(() -> !immediate().isEmpty(), "the reconnect's catch-up");
        runImmediate();
        assertEquals(2, notifier.shown.size());
        assertEquals("chat:cfg1:4", notifier.shown.get(0).tag);
        assertEquals("chat:cfg1:3", notifier.shown.get(1).tag);
        assertTrue(held.isEmpty());
    }

    @Test
    public void aPollingRunWhileAStreamIsDownDrawsItsSecondPollsHoldBeforeItEnds() throws Exception {
        mirrorMode(1, BrowserMode.WAIT, account("cfg1", "Serveur A"));
        NtfyServer n = addNtfy(ntfyServer, CACHE);
        Subscription a = store.subscribe("cfg1", n.url, false);
        // the stream is refused and waits for its reconnect
        ntfyServer.enqueue(new MockResponse().setResponseCode(503));
        engine().startRealtime();
        awaitClosed(1);
        // a level the job reads as a poll while the service runs: the second poll brings m2, stamped 10 s later
        ntfyServer.enqueue(new MockResponse().setBody(chatOnline(a, "m1")));
        ntfyServer.enqueue(new MockResponse().setBody(groupOnlineAt(a, "m2", NOW / 1000 + 10)));
        engine.runDue(level(3));
        assertEquals(Collections.singletonList(PushEngine.HOLD_MS), sleeps);
        assertEquals(2, notifier.shown.size());
        assertEquals("chat:cfg1:4", notifier.shown.get(0).tag);
        assertEquals("chat:cfg1:3", notifier.shown.get(1).tag);
        assertTrue(held.isEmpty());
    }
}
