package ca.erplibre.home.chatpush;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.BatteryManager;
import android.os.PowerManager;
import android.util.Log;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import okhttp3.OkHttpClient;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The chat push of this process: one PushEngine over the native stores,
 * drawn by ChatNotifier, built on first use and kept for the life of the
 * process. The public methods are what the Capacitor plugin calls; each
 * one that changes what the engine reads (settings, ntfy servers,
 * subscriptions) ends with engine.onSettingsChanged().
 *
 * Ordering the caller keeps: the engine forgets the session copy of an
 * account absent from the last mirror unless the copy was saved after that
 * mirror. A pending endpoint (unsubscribe) is therefore queued before the
 * publishSettings that drops its account, and an account whose session was
 * just mirrored is published before or with the next change.
 */
public final class ChatPushRuntime {

    static final String STORE_FILE = "erplibre_chat_push";
    static final String SETTINGS_FILE = "erplibre_chat_push_settings";
    static final String SESSIONS_FILE = "erplibre_chat_push_sessions";
    static final String KEY_ALIAS = "erplibre_chat_push";

    /** Whether this build carries the permanent realtime service; health and the level policy read it. */
    static final boolean REALTIME_BUILD = true;

    private static final String TAG = "ChatPushRuntime";
    private static ChatPushRuntime instance;

    private final Context context;
    private final PushStore store;
    private final PushSettingsStore settings;
    private final NativeSessions sessions;
    private final NtfyClient ntfy;
    private final ChatNotifier notifier;
    private final PushEngine.Clock clock;
    private final PushEngine engine;

    private ChatPushRuntime(Context c) {
        context = c.getApplicationContext();
        SecretBox box = new SecretBox(KeystoreKeys.provider(KEY_ALIAS));
        store = new PushStore(new PrefsKeyValue(context, STORE_FILE), box);
        settings = new PushSettingsStore(new PrefsKeyValue(context, SETTINGS_FILE));
        clock = System::currentTimeMillis;
        sessions = new NativeSessions(new PrefsKeyValue(context, SESSIONS_FILE), box, clock::now);
        // No call timeout and no redirect: a stream lasts as long as it lives, and both clients
        // set their own read timeouts
        OkHttpClient http = new OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .callTimeout(0, TimeUnit.SECONDS)
                .followRedirects(false)
                .followSslRedirects(false)
                .build();
        ntfy = new NtfyClient(http);
        notifier = new ChatNotifier(context, settings);
        notifier.syncChannels(settings.accounts(), settings.strings());
        engine = new PushEngine(store, settings, sessions, ntfy, new OdooDirect(http), notifier, clock,
                new ExecutorScheduler(), REALTIME_BUILD);
    }

    /** The process's runtime, built on the first call. */
    public static synchronized ChatPushRuntime get(Context c) {
        if (instance == null) instance = new ChatPushRuntime(c);
        return instance;
    }

    PushEngine engine() {
        return engine;
    }

    PushStore store() {
        return store;
    }

    PushSettingsStore settings() {
        return settings;
    }

    NativeSessions sessions() {
        return sessions;
    }

    /**
     * Records whether the app is in the foreground, durably before it
     * returns. It touches only the settings file, so the activity's resume
     * and pause never wait for the runtime to be built.
     */
    public static void setForeground(Context c, boolean foreground) {
        new PushSettingsStore(new PrefsKeyValue(c, SETTINGS_FILE)).setForeground(foreground);
    }

    public static boolean realtimeBuild() {
        return REALTIME_BUILD;
    }

    /**
     * Replaces the mirror: level, cleartext permission, strings and the
     * accounts, each {configId, label, lockScreen, channels: [{id, name,
     * type}]}. The channels follow the accounts. JSONException on an
     * account without configId or a channel without a numeric id.
     */
    public synchronized void publishSettings(int level, boolean allowHttp, Map<String, String> strings,
            JSONArray accounts) throws JSONException {
        List<AccountView> views = new ArrayList<>();
        for (int i = 0; i < accounts.length(); i++) {
            JSONObject a = accounts.getJSONObject(i);
            Map<Long, ChannelInfo> channels = new HashMap<>();
            JSONArray ch = a.optJSONArray("channels");
            if (ch != null) {
                for (int j = 0; j < ch.length(); j++) {
                    JSONObject c = ch.getJSONObject(j);
                    channels.put(c.getLong("id"), new ChannelInfo(c.optString("name"), c.optString("type")));
                }
            }
            String configId = a.getString("configId");
            if (configId.isEmpty()) throw new JSONException("empty configId");
            views.add(new AccountView(configId, a.optString("label"),
                    LockScreenMode.fromKey(a.optString("lockScreen")), channels));
        }
        settings.put(level, allowHttp, strings, views);
        notifier.syncChannels(views, settings.strings());
        engine.onSettingsChanged();
    }

    /**
     * Checks that the token may read "&lt;prefix&gt;check" on the server,
     * then stores the server. Returns null when stored, else the refusal
     * kind in lower case (unauthorized, forbidden, unreachable, http_refused,
     * protocol...); nothing is stored then.
     */
    public synchronized String setNtfy(String url, String token, String prefix, int cacheSeconds) {
        NtfyServer s = new NtfyServer(url, token, prefix, cacheSeconds);
        try {
            ntfy.checkRead(s, prefix + "check", settings.allowHttp());
        } catch (NtfyException e) {
            return e.kind().name().toLowerCase(Locale.ROOT);
        } catch (IllegalArgumentException e) {
            return "protocol";
        }
        store.putNtfy(s);
        engine.onSettingsChanged();
        return null;
    }

    /** Forgets the server, its cursor and seen ids; its accounts are unsubscribed by the caller. */
    public synchronized void removeNtfy(String url) {
        store.removeNtfy(url);
        engine.onSettingsChanged();
    }

    /**
     * The account's subscription on the server, drawn anew when renew is set
     * or when none fits: {topic, p256dh, auth}, both keys base64url.
     * IllegalArgumentException when the server is unknown.
     */
    public synchronized JSONObject subscribe(String configId, String ntfyUrl, boolean renew) throws JSONException {
        Subscription s = store.subscribe(configId, ntfyUrl, renew);
        engine.onSettingsChanged();
        return new JSONObject()
                .put("topic", s.topic)
                .put("p256dh", WebPushKeys.b64url(s.publicKey))
                .put("auth", WebPushKeys.b64url(s.authSecret));
    }

    /**
     * Drops the account's subscription. A pending endpoint is queued first,
     * so the session copy stays until the engine has unregistered it.
     */
    public synchronized void unsubscribe(String configId, String pendingEndpoint) {
        if (pendingEndpoint != null && !pendingEndpoint.isEmpty()) {
            sessions.addPendingUnregister(configId, pendingEndpoint);
        }
        store.unsubscribe(configId);
        engine.onSettingsChanged();
    }

    /** Stores the account's session copy, dated now on the engine's clock, and clears its expired mark. */
    public synchronized void mirrorSession(String configId, String odooUrl, String database, String sessionId) {
        sessions.put(new NativeSession(configId, odooUrl, database, sessionId, clock.now()));
    }

    public synchronized void forgetSession(String configId) {
        sessions.forget(configId);
    }

    /** HealthSnapshot.toJson() plus notificationsAllowed. */
    public JSONObject health() throws JSONException {
        return engine.health().toJson().put("notificationsAllowed", notifier.allowed());
    }

    /** One run of the periodic job at the level the settings and the power state give; blocks on the network. */
    public void checkNow() {
        engine.runDue(effective());
    }

    PushLevelPolicy.Effective effective() {
        return PushLevelPolicy.resolve(settings.level(), powerState(context), REALTIME_BUILD,
                PushLevelPolicy.NO_CLIMB);
    }

    /**
     * Removes notifications of the account: the conversation channelId when
     * given, every inbox notification when inbox, the summary when summary.
     * With none of the three, every chat, inbox and summary notification of
     * the account; its status notification stays.
     */
    public void clear(String configId, Long channelId, boolean inbox, boolean summary) {
        boolean all = channelId == null && !inbox && !summary;
        for (String tag : notifier.shownTags()) {
            boolean hit = false;
            if (channelId != null && tag.equals("chat:" + configId + ":" + channelId)) hit = true;
            if ((inbox || all) && tag.startsWith("inbox:" + configId + ":")) hit = true;
            if ((summary || all) && tag.equals("summary:" + configId)) hit = true;
            if (all && tag.startsWith("chat:" + configId + ":")) hit = true;
            if (hit) notifier.cancel(tag);
        }
    }

    public Set<String> shown() {
        return notifier.shownTags();
    }

    /** Wifi, charger, battery saver and battery level now; unknown facts read as false, 100 %. */
    static PushLevelPolicy.PowerState powerState(Context c) {
        boolean wifi = false;
        boolean charging = false;
        boolean saver = false;
        int pct = 100;
        try {
            ConnectivityManager cm = c.getSystemService(ConnectivityManager.class);
            Network n = cm == null ? null : cm.getActiveNetwork();
            NetworkCapabilities caps = n == null ? null : cm.getNetworkCapabilities(n);
            wifi = caps != null && (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                    || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET));
        } catch (RuntimeException e) {
            // the network state is unreadable: not on wifi
        }
        BatteryManager bm = c.getSystemService(BatteryManager.class);
        if (bm != null) {
            charging = bm.isCharging();
            int cap = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
            if (cap > 0 && cap <= 100) pct = cap;
        }
        PowerManager pm = c.getSystemService(PowerManager.class);
        if (pm != null) saver = pm.isPowerSaveMode();
        return new PushLevelPolicy.PowerState(wifi, charging, saver, pct);
    }

    /**
     * The engine's Scheduler: two daemon threads, so a reconnect is not held
     * behind an Odoo check. A task always runs on one of them, never on the
     * caller's thread. cancelAll makes every task scheduled before it a
     * no-op when its time comes.
     */
    private static final class ExecutorScheduler implements PushEngine.Scheduler {

        private final AtomicInteger generation = new AtomicInteger();
        private final ScheduledThreadPoolExecutor executor;

        ExecutorScheduler() {
            executor = new ScheduledThreadPoolExecutor(2, new ThreadFactory() {
                private final AtomicInteger n = new AtomicInteger();

                @Override
                public Thread newThread(Runnable r) {
                    Thread t = new Thread(r, "chat-push-" + n.incrementAndGet());
                    t.setDaemon(true);
                    return t;
                }
            });
        }

        @Override
        public void schedule(final Runnable r, long delayMs) {
            final int g = generation.get();
            executor.schedule(new Runnable() {
                @Override
                public void run() {
                    if (generation.get() != g) return;
                    try {
                        r.run();
                    } catch (RuntimeException e) {
                        // the class only: a message may carry a URL
                        Log.w(TAG, "scheduled task failed: " + e.getClass().getSimpleName());
                    }
                }
            }, Math.max(0L, delayMs), TimeUnit.MILLISECONDS);
        }

        @Override
        public void cancelAll() {
            generation.incrementAndGet();
        }
    }
}
