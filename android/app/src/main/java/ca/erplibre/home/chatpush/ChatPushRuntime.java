package ca.erplibre.home.chatpush;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.BatteryManager;
import android.os.PowerManager;
import android.util.Log;
import ca.erplibre.home.BuildConfig;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import okhttp3.OkHttpClient;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The chat push of this process: one PushEngine over the native stores,
 * drawn by ChatNotifier, built on first use and kept for the life of the
 * process. The public methods are what the Capacitor plugin calls; each
 * one that changes what the engine reads ends with engine.onSettingsChanged()
 * for a new mirror (publishSettings), engine.onStoresChanged() for the ntfy
 * servers and the subscriptions.
 *
 * The permanent service (ca.erplibre.home.chatpush.realtime, present only
 * in a realtime build) drives the engine through serviceStarted,
 * applyRealtime, onNetworkAvailable and serviceStopped; while it runs, the
 * engine's state reaches it as the permanent notification line, and the
 * heartbeat that health reports as serviceAlive is written at most every
 * BEAT_EVERY_MS.
 *
 * Ordering the caller keeps: the engine forgets the session copy of an
 * account absent from the last mirror unless the copy was saved after that
 * mirror. A pending endpoint (unsubscribe) is therefore queued before the
 * publishSettings that drops its account, and an account whose session was
 * just mirrored is published before or with the next change.
 *
 * The notification actions live beside the engine: one ActionStore and one
 * ActionRunner for the process, shared by ChatActionReceiver, ChatActionJob
 * and ChatPushJob. A run that ends an action (or hands it to the app)
 * reaches the actions listener, the plugin's « actions » event while the
 * app runs; the app drains with actions() and acks with ackActions().
 */
public final class ChatPushRuntime {

    static final String STORE_FILE = "erplibre_chat_push";
    static final String SETTINGS_FILE = "erplibre_chat_push_settings";
    static final String SESSIONS_FILE = "erplibre_chat_push_sessions";
    static final String ACTIONS_FILE = "erplibre_chat_push_actions";
    /** The chat messages held while a browser is active: ntfy ciphertext only (HeldStore). */
    static final String HELD_FILE = "erplibre_chat_push_held";
    static final String KEY_ALIAS = "erplibre_chat_push";

    /** Whether this build carries the permanent realtime service; health and the level policy read it. */
    static final boolean REALTIME_BUILD = BuildConfig.CHAT_REALTIME;

    /** The heartbeat is written at most this often; health counts it alive for PushEngine.BEAT_MAX_AGE_MS. */
    static final long BEAT_EVERY_MS = 5L * 60 * 1000;

    /** The partial wakelock taken around a streamed message lapses after this, whatever happens. */
    static final long MESSAGE_WAKE_MS = 10_000L;

    /** The test door's fake power state, present only in a -PsyncTest build. */
    static final String TEST_POWER_CLASS = "ca.erplibre.home.chatpush.TestPower";

    private static final String TAG = "ChatPushRuntime";
    private static ChatPushRuntime instance;
    /** Set while a permanent service of this process runs, between serviceStarted and serviceStopped. */
    private static volatile boolean serviceRunning;
    /** Told after every action run; set by the plugin while the app runs, null otherwise. */
    private static volatile Runnable actionsListener;

    private final Context context;
    private final PushStore store;
    private final PushSettingsStore settings;
    private final NativeSessions sessions;
    private final NtfyClient ntfy;
    private final ChatNotifier notifier;
    private final PushEngine.Clock clock;
    private final PushEngine engine;
    private final ActionStore actions;
    private final ActionRunner runner;
    private final AtomicLong beatAt = new AtomicLong();
    /** Whether applyRealtime opened the streams. Guarded by this. */
    private boolean realtimeOn;
    /** The level applyRealtime last applied; null before the first. */
    private volatile PushLevelPolicy.Effective applied;

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
        // the held messages wait for their ntfy's catch-up: nothing is released at construction
        engine = new PushEngine(store, settings, sessions, ntfy, new OdooDirect(http), notifier, clock,
                new ExecutorScheduler(), new HeldStore(new PrefsKeyValue(context, HELD_FILE), clock::now),
                REALTIME_BUILD);
        engine.setWake(new MessageWake(context));
        engine.setHoldWake(new HoldWake(context));
        engine.setHoldTimer(new ExecutorHoldTimer());
        engine.setLocalTime(new ZoneTime());
        actions = new ActionStore(new PrefsKeyValue(context, ACTIONS_FILE), box, clock::now);
        // OdooActions derives its own client from http: no replay of a call, its own timeouts
        runner = new ActionRunner(actions, sessions, settings, new OdooActions(http), clock::now);
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

    ActionStore actionStore() {
        return actions;
    }

    ActionRunner runner() {
        return runner;
    }

    ChatNotifier notifier() {
        return notifier;
    }

    // ---- the notification actions ----

    /** Sets who is told after each action run (the plugin's « actions » event); null drops it. */
    public static void setActionsListener(Runnable listener) {
        actionsListener = listener;
    }

    /** Tells the actions listener, if any; its failure stays its own. */
    static void announceActions() {
        Runnable l = actionsListener;
        if (l == null) return;
        try {
            l.run();
        } catch (RuntimeException e) {
            Log.w(TAG, "actions listener failed: " + e.getClass().getSimpleName());
        }
    }

    /** The DONE and HANDOFF actions waiting for the app, oldest first, as ChatAction.toJson writes them. */
    public JSONArray actions() {
        JSONArray out = new JSONArray();
        for (ChatAction a : actions.forDrain()) out.put(a.toJson());
        return out;
    }

    /**
     * Forgets the drained actions among ids (a PENDING or RUNNING one stays
     * native code's), then redraws the handoff notification of each account
     * they belonged to: gone once none is left.
     */
    public void ackActions(Collection<String> ids) {
        Set<String> configs = new HashSet<>();
        for (String id : ids) {
            ChatAction a = actions.get(id);
            if (a != null) configs.add(a.configId);
        }
        actions.ack(ids);
        for (String configId : configs) notifier.handoff(configId, actions.handoffCount(configId));
    }

    /**
     * What follows one run: a handoff redraws its account's handoff
     * notification, and the listener is told.
     */
    void afterRun(String id, ActionRunner.Outcome o) {
        if (o == ActionRunner.Outcome.HANDOFF) {
            ChatAction a = actions.get(id);
            if (a != null) notifier.handoff(a.configId, actions.handoffCount(a.configId));
        }
        announceActions();
    }

    /**
     * Turns back the RUNNING actions of a dead process, then runs every due
     * one (ActionRunner.runDue), then draws the handoff notification of
     * every account with actions waiting for the app: one handed off now
     * alerts as handoff() does, the others come back silently (a prompt
     * lost to a death or swiped away). Blocks on the network; never on the
     * main thread.
     */
    void runActions() {
        actions.recover();
        Map<String, ActionRunner.Outcome> out = runner.runDue();
        Set<String> handed = new HashSet<>();
        for (Map.Entry<String, ActionRunner.Outcome> e : out.entrySet()) {
            if (e.getValue() != ActionRunner.Outcome.HANDOFF) continue;
            ChatAction a = actions.get(e.getKey());
            if (a != null) handed.add(a.configId);
        }
        for (Map.Entry<String, Integer> e : actions.handoffCounts().entrySet()) {
            notifier.handoff(e.getKey(), e.getValue(), handed.contains(e.getKey()));
        }
        if (!out.isEmpty()) announceActions();
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
     * Replaces the mirror: level, cleartext permission, phone-wide prefs,
     * strings and the accounts, each {configId, label, lockScreen, module,
     * channels: [{id, name, type}]} plus the AccountPrefs keys, module the
     * level of erplibre_mobile_chat a post uses ("" or absent: none). The
     * channels follow the accounts. JSONException on an account without
     * configId or a channel without a numeric id.
     */
    public synchronized void publishSettings(int level, boolean allowHttp, PhonePrefs prefs,
            Map<String, String> strings, JSONArray accounts) throws JSONException {
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
                    LockScreenMode.fromKey(a.optString("lockScreen")), channels, a.optString("module"),
                    AccountView.AccountPrefs.of(a)));
        }
        settings.put(level, allowHttp, prefs, strings, views);
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
        engine.onStoresChanged();
        return null;
    }

    /** Forgets the server, its cursor and seen ids; its accounts are unsubscribed by the caller. */
    public synchronized void removeNtfy(String url) {
        store.removeNtfy(url);
        engine.onStoresChanged();
    }

    /**
     * The account's subscription on the server, drawn anew when renew is set
     * or when none fits: {topic, p256dh, auth}, both keys base64url.
     * IllegalArgumentException when the server is unknown.
     */
    public synchronized JSONObject subscribe(String configId, String ntfyUrl, boolean renew) throws JSONException {
        Subscription s = store.subscribe(configId, ntfyUrl, renew);
        engine.onStoresChanged();
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
        engine.onStoresChanged();
    }

    /** Stores the account's session copy, dated now on the engine's clock, and clears its expired mark. */
    public synchronized void mirrorSession(String configId, String odooUrl, String database, String sessionId) {
        sessions.put(new NativeSession(configId, odooUrl, database, sessionId, clock.now()));
    }

    public synchronized void forgetSession(String configId) {
        sessions.forget(configId);
    }

    /**
     * HealthSnapshot.toJson() plus notificationsAllowed, at the level the
     * settings and the power state give now, handed to the engine first: a
     * level 1 to 4 that climbed or came down since the last run reads as it
     * is. A level wanting the permanent service while none runs reads as
     * the 15-minute poll it falls back to, as PushEngine.runPeriod runs it.
     * A permanent service running in this process beats first, so a
     * heartbeat older than the last write period never reads as a dead
     * service.
     */
    public JSONObject health() throws JSONException {
        if (serviceRunning) beat(false);
        PushLevelPolicy.Effective e = effective();
        engine.setEffective(e.permanentService && !serviceRunning ? PushLevelPolicy.withoutService(e) : e);
        return engine.health().toJson().put("notificationsAllowed", notifier.allowed());
    }

    // ---- the permanent service ----

    /** Whether a permanent service runs in this process now. */
    static boolean serviceRunning() {
        return serviceRunning;
    }

    /** The chat line of the permanent notification for the engine's state now. */
    public String permanentLine() {
        return engine.health().permanentLine(settings.strings(), settings.accounts());
    }

    /**
     * The permanent service started: it is counted alive, beats, and gets
     * each later line through line. line runs with the engine's monitor
     * held, on any thread: it only draws.
     */
    public void serviceStarted(final Consumer<String> line) {
        serviceRunning = true;
        beat(true);
        notifier.onStatus(h -> {
            beat(false);
            line.accept(h.permanentLine(settings.strings(), settings.accounts()));
        });
    }

    /** The permanent service stops: no more lines, the streams close, it is no longer counted alive. */
    public void serviceStopped() {
        notifier.onStatus(null);
        serviceRunning = false;
        boolean wasOn;
        synchronized (this) {
            wasOn = realtimeOn;
            realtimeOn = false;
        }
        if (wasOn) engine.stopRealtime();
    }

    /**
     * Re-reads the level and the power state: realtime opens the streams,
     * any other mode closes them, and leaving realtime polls once at once
     * so what arrived meanwhile is caught up. Blocks on the network then.
     * The engine gets the level for health, and ChatClimbJob is aligned
     * with it: a climb that stops the service leaves the job waiting for
     * the charger. Returns whether the permanent service is still wanted.
     */
    public boolean applyRealtime() {
        PushLevelPolicy.PowerState real = realPowerState(context);
        PushLevelPolicy.Effective e = resolve(settings, context, real);
        applied = e;
        engine.setEffective(e);
        ChatClimbJob.sync(context, e, real.plugged);
        boolean left = false;
        synchronized (this) {
            if (e.mode == PushLevelPolicy.Mode.REALTIME) {
                realtimeOn = true;
                engine.startRealtime();
            } else if (realtimeOn) {
                realtimeOn = false;
                engine.stopRealtime();
                left = true;
            }
        }
        if (left && e.mode != PushLevelPolicy.Mode.OFF) engine.runDue(e);
        return e.permanentService;
    }

    /**
     * Whether the level the settings and the power state give now differs
     * from the one applyRealtime last applied in level, mode or climb
     * reason (BatteryClimber.differs): the permanent service re-reads the
     * level on a battery change only then.
     */
    public boolean levelChanged() {
        return BatteryClimber.differs(applied, effective());
    }

    /** The network came back: streams waiting for their backoff reopen now. */
    public void onNetworkAvailable() {
        engine.onNetworkAvailable();
    }

    /** Writes the heartbeat when forced or when the last one is BEAT_EVERY_MS old. */
    private void beat(boolean force) {
        long now = clock.now();
        long last = beatAt.get();
        if (!force && now - last < BEAT_EVERY_MS) return;
        if (beatAt.compareAndSet(last, now)) settings.beat(now);
    }

    /**
     * One run of the periodic job at the level the settings and the power
     * state give; a level wanting the permanent service while none runs in
     * this process polls (PushEngine.runPeriod). Blocks on the network.
     */
    public void checkNow() {
        engine.runPeriod(effective(), serviceRunning);
    }

    /** The level the settings give, climbed by the power state now (BatteryClimber). */
    PushLevelPolicy.Effective effective() {
        return resolve(settings, context, realPowerState(context));
    }

    /** effective() read from the settings file alone, without building the runtime. */
    static PushLevelPolicy.Effective effective(Context c) {
        return effective(c, realPowerState(c));
    }

    /** effective(c) for a real power state the caller already read (realPowerState). */
    static PushLevelPolicy.Effective effective(Context c, PushLevelPolicy.PowerState real) {
        return resolve(new PushSettingsStore(new PrefsKeyValue(c, SETTINGS_FILE)), c, real);
    }

    /** The mirrored level and climbing prefs resolved against real, as the test door overrides it. */
    private static PushLevelPolicy.Effective resolve(PushSettingsStore s, Context c,
            PushLevelPolicy.PowerState real) {
        return PushLevelPolicy.resolve(s.level(), testPowerOver(c, real), REALTIME_BUILD,
                BatteryClimber.of(s.prefs()));
    }

    /** Removes the account's notifications NotificationModel.Clear names, by their post time. */
    public void clear(String configId, Long channelId, boolean inbox, String model, Long resId, boolean summary,
            Long before) {
        NotificationModel.Clear c = new NotificationModel.Clear(configId, channelId, inbox, model, resId, summary, before);
        for (Map.Entry<String, Long> shown : notifier.shownAt().entrySet()) {
            if (c.matches(shown.getKey(), shown.getValue())) notifier.cancel(shown.getKey());
        }
    }

    public Set<String> shown() {
        return notifier.shownTags();
    }

    /**
     * Wifi, plugged in, battery saver and battery level now, as the device
     * reports them; unknown facts read as false, 100 %. Plugged and the
     * percentage come from the sticky ACTION_BATTERY_CHANGED (EXTRA_PLUGGED
     * non-zero; EXTRA_LEVEL·100/EXTRA_SCALE), readable from a job without
     * registering a receiver.
     */
    static PushLevelPolicy.PowerState realPowerState(Context c) {
        boolean wifi = false;
        boolean plugged = false;
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
        Intent battery = null;
        try {
            battery = c.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        } catch (RuntimeException e) {
            // the battery state is unreadable: unplugged, 100 %
        }
        if (battery != null) {
            plugged = battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0;
            int level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            if (level >= 0 && scale > 0) pct = Math.min(100, level * 100 / scale);
        }
        PowerManager pm = c.getSystemService(PowerManager.class);
        if (pm != null) saver = pm.isPowerSaveMode();
        return new PushLevelPolicy.PowerState(wifi, plugged, saver, pct);
    }

    /**
     * real through TestPower.over when this build carries the test door's
     * fake power state (found by class name, as RealtimeHost finds the
     * service), else real itself.
     */
    private static PushLevelPolicy.PowerState testPowerOver(Context c, PushLevelPolicy.PowerState real) {
        Method over = TestPowerLookup.OVER;
        if (over == null) return real;
        try {
            return (PushLevelPolicy.PowerState) over.invoke(null, c, real);
        } catch (IllegalAccessException | InvocationTargetException | ClassCastException e) {
            Log.w(TAG, "test power unread: " + e.getClass().getSimpleName());
            return real;
        }
    }

    /** TestPower.over, looked up once on first use; null in every build without the class. */
    private static final class TestPowerLookup {
        static final Method OVER = find();

        private static Method find() {
            try {
                Method m = Class.forName(TEST_POWER_CLASS)
                        .getDeclaredMethod("over", Context.class, PushLevelPolicy.PowerState.class);
                m.setAccessible(true);
                return m;
            } catch (ClassNotFoundException | NoSuchMethodException | LinkageError | SecurityException e) {
                return null;
            }
        }
    }

    /**
     * The engine's time of day: the device's default time zone, looked up at
     * each call, so a zone changed while the process lives applies to the
     * next post. Calendar rather than java.time, which needs API 26.
     */
    private static final class ZoneTime implements PushEngine.LocalTime {

        @Override
        public int minuteOfDay(long epochMs) {
            Calendar c = Calendar.getInstance(TimeZone.getDefault());
            c.setTimeInMillis(epochMs);
            return c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE);
        }
    }

    /**
     * A partial wakelock held while at least one streamed message is being
     * processed, re-armed for MESSAGE_WAKE_MS at each acquire. None is held
     * otherwise: a permanent wakelock is what vendor app killers act on.
     */
    private static final class MessageWake implements PushEngine.Wake {

        private final PowerManager.WakeLock lock;
        private int inFlight;

        MessageWake(Context c) {
            PowerManager pm = c.getSystemService(PowerManager.class);
            lock = pm == null ? null : pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "erplibre:chat-message");
            if (lock != null) lock.setReferenceCounted(false);
        }

        @Override
        public synchronized void acquire() {
            if (lock == null) return;
            inFlight++;
            lock.acquire(MESSAGE_WAKE_MS);
        }

        @Override
        public synchronized void release() {
            if (lock == null) return;
            inFlight = Math.max(0, inFlight - 1);
            if (inFlight == 0 && lock.isHeld()) lock.release();
        }
    }

    /**
     * The partial wakelock of the browser-active hold, apart from the
     * message wakelock (whose release at the end of each message would drop
     * it): each acquire replaces the timeout, which the engine only ever
     * moves later; release lets it go once nothing is held.
     */
    private static final class HoldWake implements PushEngine.Wake {

        private final PowerManager.WakeLock lock;

        HoldWake(Context c) {
            PowerManager pm = c.getSystemService(PowerManager.class);
            lock = pm == null ? null : pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "erplibre:chat-hold");
            if (lock != null) lock.setReferenceCounted(false);
        }

        @Override
        public void acquire() {
            acquire(PushEngine.HOLD_MS + PushEngine.HOLD_WAKE_EXTRA_MS);
        }

        @Override
        public synchronized void acquire(long timeoutMs) {
            if (lock != null) lock.acquire(timeoutMs);
        }

        @Override
        public synchronized void release() {
            if (lock != null && lock.isHeld()) lock.release();
        }
    }

    /**
     * The engine's HoldTimer: one daemon thread of its own, which the
     * Scheduler's cancelAll never reaches, so a stream stopped inside a hold
     * still releases it. The delay runs on the monotonic clock, only while
     * the CPU is awake (the hold's wakelock keeps it so); no exact alarm.
     */
    private static final class ExecutorHoldTimer implements PushEngine.HoldTimer {

        private final ScheduledThreadPoolExecutor executor;

        ExecutorHoldTimer() {
            executor = new ScheduledThreadPoolExecutor(1, new ThreadFactory() {
                @Override
                public Thread newThread(Runnable r) {
                    Thread t = new Thread(r, "chat-hold");
                    t.setDaemon(true);
                    return t;
                }
            });
        }

        @Override
        public void at(final Runnable r, long delayMs) {
            executor.schedule(new Runnable() {
                @Override
                public void run() {
                    try {
                        r.run();
                    } catch (RuntimeException e) {
                        Log.w(TAG, "hold release failed: " + e.getClass().getSimpleName());
                    }
                }
            }, Math.max(0L, delayMs), TimeUnit.MILLISECONDS);
        }
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
