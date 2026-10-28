package ca.erplibre.home.chatpush;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Random;
import java.util.Set;
import okhttp3.Call;
import org.json.JSONException;

/**
 * Turns ntfy messages and Odoo unread counters into notifications.
 * Capacitor-free and Android-free: the screen is a Notifier, time a Clock,
 * delayed work a Scheduler.
 *
 * One stream per distinct ntfy carries the topics of every account on it.
 * Every message, streamed or polled, goes through one path: de-duplicated by
 * id, routed by topic, decrypted, shown unless the app is in the foreground,
 * then the server's cursor and contact time saved. An account without ntfy,
 * or one whose ntfy was silent longer than its cache, is checked against Odoo
 * directly and gets one summary notification per server.
 *
 * Threading: stream callbacks arrive on OkHttp threads, the other entry
 * points on the caller's. Every piece of state is guarded by one monitor,
 * never held across a network call: a poll or an Odoo check reads what it
 * needs under the monitor, runs outside it, then applies its result under
 * it. runDue runs one at a time. Notifier calls are made with the monitor
 * held. The Odoo check owed after a silence runs from the Scheduler, never
 * on a stream's reader thread.
 */
final class PushEngine {

    /**
     * What the engine draws. Its methods run with the engine's monitor held,
     * so an implementation never calls back into the engine.
     */
    interface Notifier {
        void show(NotificationModel.Shown n);

        void cancel(String tag);

        /** Removes every notification of the account (chat, inbox, summary, status). */
        void cancelAll(String configId);

        /** The tags of the notifications currently drawn. */
        Set<String> shownTags();

        /** The engine's state changed (permanent notification line). */
        void status(HealthSnapshot h);
    }

    interface Clock {
        long now();
    }

    /**
     * Keeps the device awake while a streamed message is processed: acquire
     * before, release after, on the stream's reader thread. Called without
     * the engine's monitor; two streams may overlap their holds.
     */
    interface Wake {
        void acquire();

        void release();
    }

    private static final Wake NO_WAKE = new Wake() {
        @Override
        public void acquire() {}

        @Override
        public void release() {}
    };

    /**
     * Delayed work. schedule() is called with the engine's monitor held: it
     * never runs r on the calling thread, and runs it on a thread that may
     * block on the network (r can be an Odoo check).
     */
    interface Scheduler {
        void schedule(Runnable r, long delayMs);

        void cancelAll();
    }

    /** Successive waits before reopening a closed stream; the last one repeats. */
    static final long[] RECONNECT_MS = {5_000, 15_000, 30_000, 60_000, 120_000, 300_000};

    /** Up to this fraction of the wait is added at random, so phones do not reconnect in step. */
    static final double JITTER = 0.2;
    static final long POLL_60_MS = 60L * 60 * 1000;
    /** A keepalive saves the contact time at most this often (each save is a durable write). */
    static final long CONTACT_SAVE_MS = 5L * 60 * 1000;
    static final long BEAT_MAX_AGE_MS = 10L * 60 * 1000;
    /** Failed runs in a row before a status notification, at levels without the permanent service. */
    static final int FAILED_RUNS_FOR_STATUS = 2;
    /**
     * A connected stream with no contact for this long is taken for dead:
     * three of ntfy's default keepalives (45 s), above the longest one an
     * operator sets (about 100 s). Measured on the wall clock, which runs
     * in deep sleep where the read timeout and the backoff do not.
     */
    static final long STALE_CONTACT_MS = 3 * 45_000L;

    private enum LinkState { CONNECTING, CONNECTED, POLLING, ERROR, OFF }

    /** One ntfy and its stream. Guarded by the monitor. */
    private static final class Link {
        final String url;
        NtfyServer server;
        List<String> topics = Collections.emptyList();
        List<String> configIds = Collections.emptyList();
        /** The live call, or null. */
        Call call;
        /** Bumped by every open, stop and scheduled reconnect: a callback or a task of another generation is stale. */
        int generation;
        int attempt;
        /** A reconnect is scheduled. */
        boolean waiting;
        LinkState state = LinkState.OFF;
        NtfyException.Kind reason;
        /** The last close was a refusal no retry fixes; the reason stays until onStoresChanged. */
        boolean fatal;
        long contactAt;
        long contactSavedAt;
        SeenIds seen;

        Link(String url) {
            this.url = url;
        }
    }

    /** What the last Odoo-direct check of an account gave. Guarded by the monitor. */
    private static final class AccountState {
        long lastCheckAt;
        boolean ok;
        OdooDirectException.Kind reason;
    }

    private final PushStore store;
    private final PushSettingsStore settings;
    private final NativeSessions sessions;
    private final NtfyClient ntfy;
    private final OdooDirect odoo;
    private final Notifier notifier;
    private final Clock clock;
    private final Scheduler scheduler;
    private final boolean realtimeBuild;
    private volatile Wake wake = NO_WAKE;

    private final Object lock = new Object();
    private final Object runLock = new Object();
    private final Random random = new Random();
    private final Map<String, Link> links = new LinkedHashMap<>();
    private final Map<String, AccountState> accounts = new HashMap<>();
    /** Accounts whose owed check runs now, so a second drain does not take it too. */
    private final Set<String> draining = new HashSet<>();
    private Set<String> mirrored;
    private boolean allowHttp;
    private boolean realtime;
    private PushLevelPolicy.Effective effective;
    private int undecryptable;
    private int faults;

    PushEngine(PushStore store, PushSettingsStore settings, NativeSessions sessions, NtfyClient ntfy,
            OdooDirect odoo, Notifier notifier, Clock clock, Scheduler scheduler) {
        this(store, settings, sessions, ntfy, odoo, notifier, clock, scheduler, false);
    }

    /** realtimeBuild says whether this build carries the permanent service; health reports it. */
    PushEngine(PushStore store, PushSettingsStore settings, NativeSessions sessions, NtfyClient ntfy,
            OdooDirect odoo, Notifier notifier, Clock clock, Scheduler scheduler, boolean realtimeBuild) {
        this.store = store;
        this.settings = settings;
        this.sessions = sessions;
        this.ntfy = ntfy;
        this.odoo = odoo;
        this.notifier = notifier;
        this.clock = clock;
        this.scheduler = scheduler;
        this.realtimeBuild = realtimeBuild;
        synchronized (lock) {
            mirrored = mirroredIds();
            allowHttp = settings.allowHttp();
            syncLinks(false);
        }
    }

    /** Sets the hold taken around each streamed message; null takes none. */
    void setWake(Wake w) {
        wake = w == null ? NO_WAKE : w;
    }

    // ---- entry points ----

    /** Opens one stream per ntfy that has subscriptions; a stream already open or waiting is left alone. */
    void startRealtime() {
        synchronized (lock) {
            realtime = true;
            syncLinks(false);
            for (Link l : links.values()) {
                if (l.call == null && !l.waiting) reopen(l);
            }
            publishStatus();
        }
    }

    /** Closes every stream and drops the scheduled reconnects; no callback of a closed stream acts. */
    void stopRealtime() {
        synchronized (lock) {
            realtime = false;
            for (Link l : links.values()) {
                stop(l);
                l.state = LinkState.OFF;
                l.reason = null;
            }
            scheduler.cancelAll();
            publishStatus();
        }
    }

    /**
     * One periodic run. A level that wants the permanent service while none
     * runs (Android refused its start) polls every 15 minutes and counts its
     * failed runs, as level 3 does: the run still fetches, and two failures
     * say so. Health keeps the level, so the dead service stays reported.
     */
    void runPeriod(PushLevelPolicy.Effective e, boolean serviceRunning) {
        if (e.permanentService && !serviceRunning) runDue(PushLevelPolicy.withoutService(e), true);
        else runDue(e);
    }

    /** runDue counting failed runs at the levels without the permanent service. */
    void runDue(PushLevelPolicy.Effective e) {
        runDue(e, !e.permanentService);
    }

    /**
     * One run of the periodic job. OFF does nothing. POLL_15 polls every
     * ntfy, POLL_60 an ntfy last polled 60 minutes ago or more. REALTIME
     * with the streams open reopens every stream waiting for its backoff
     * and every connected one silent for STALE_CONTACT_MS, except those
     * refused for good. When the policy asks Odoo directly, every mirrored
     * account without ntfy is checked, after any check a silence left owed.
     * Then the pending unregisters are sent. When counting, two failed runs
     * in a row of an ntfy or an account post one status notification,
     * removed by the next success.
     */
    void runDue(PushLevelPolicy.Effective e, boolean counting) {
        synchronized (runLock) {
            List<Link> due = new ArrayList<>();
            List<String> direct = new ArrayList<>();
            synchronized (lock) {
                effective = e;
                if (e.mode == PushLevelPolicy.Mode.OFF) {
                    publishStatus();
                    return;
                }
                syncLinks(false);
                long now = clock.now();
                if (e.mode == PushLevelPolicy.Mode.POLL_15 || e.mode == PushLevelPolicy.Mode.POLL_60) {
                    for (Link l : links.values()) {
                        if (e.mode == PushLevelPolicy.Mode.POLL_60 && now - lastPollAt(l.url) < POLL_60_MS) continue;
                        due.add(l);
                    }
                } else if (e.mode == PushLevelPolicy.Mode.REALTIME && realtime) {
                    for (Link l : links.values()) {
                        if (l.fatal) continue;
                        if ((l.call == null && l.waiting) || stale(l, now)) reopen(l);
                    }
                }
                if (e.odooDirect) {
                    for (String id : mirroredIds()) {
                        if (linkOf(id) == null) direct.add(id);
                    }
                }
            }
            for (Link l : due) poll(l, counting);
            drainOwedChecks();
            for (String id : direct) checkAccount(id, counting);
            runPending();
            synchronized (lock) {
                publishStatus();
            }
        }
    }

    /** Reopens at once every stream waiting for its backoff, except those refused for good. */
    void onNetworkAvailable() {
        synchronized (lock) {
            if (!realtime) return;
            for (Link l : links.values()) {
                if (l.call == null && l.waiting && !l.fatal) reopen(l);
            }
        }
    }

    /**
     * A new mirror was published: its time is recorded (a session copy
     * saved after it belongs to an account on its way in), then
     * onStoresChanged.
     */
    void onSettingsChanged() {
        synchronized (lock) {
            settings.setEngineState("mirrorAt", Long.toString(clock.now()));
            onStoresChanged();
        }
    }

    /**
     * What the engine reads changed: the mirror, the ntfy servers or the
     * subscriptions. A removed account loses its notifications, and so
     * does any tag of an account no longer mirrored (left by an earlier
     * process). A changed ntfy set or cleartext permission reopens the
     * streams; a refusal held for good is lifted and retried. A session copy
     * the last mirror no longer needs goes once nothing is left to
     * unregister.
     */
    void onStoresChanged() {
        synchronized (lock) {
            Set<String> now = mirroredIds();
            for (String id : mirrored) {
                if (!now.contains(id)) {
                    notifier.cancelAll(id);
                    forgetAccount(id);
                }
            }
            for (String tag : notifier.shownTags()) {
                if (isEngineTag(tag) && !ownedBy(tag, now)) notifier.cancel(tag);
            }
            mirrored = now;
            boolean http = settings.allowHttp();
            boolean httpChanged = http != allowHttp;
            allowHttp = http;
            List<Link> lifted = new ArrayList<>();
            for (Link l : links.values()) {
                if (l.fatal) {
                    l.fatal = false;
                    l.reason = null;
                    if (l.state == LinkState.ERROR) l.state = LinkState.CONNECTING;
                    lifted.add(l);
                }
            }
            Set<Link> reopened = syncLinks(httpChanged);
            if (realtime) {
                for (Link l : lifted) {
                    if (!reopened.contains(l) && links.get(l.url) == l) reopen(l);
                }
            }
            for (String id : now) refreshStatus(id);
            forgetOrphanSessions();
            publishStatus();
        }
    }

    HealthSnapshot health() {
        synchronized (lock) {
            return snapshot();
        }
    }

    // ---- streams ----

    /** A stream's callbacks, bound to one generation of its link. */
    private final class StreamListener implements NtfyClient.Listener {
        private final Link link;
        private final int generation;

        StreamListener(Link link, int generation) {
            this.link = link;
            this.generation = generation;
        }

        /** A callback of a stream since stopped or replaced; it must change nothing. */
        private boolean stale() {
            return !realtime || generation != link.generation || links.get(link.url) != link;
        }

        /** A silence beyond the cache owes each account a check, run off this reader thread. */
        @Override
        public void onOpen() {
            synchronized (lock) {
                if (stale()) return;
                long now = clock.now();
                if (silentTooLong(link, now)) oweChecks(link.configIds);
                link.state = LinkState.CONNECTED;
                link.attempt = 0;
                link.reason = null;
                link.fatal = false;
                touch(link, now, true);
                clearFailures(ntfyKey(link.url));
                for (String id : link.configIds) refreshStatus(id);
                publishStatus();
            }
        }

        @Override
        public void onMessage(NtfyMessage m) {
            Wake w = wake;
            w.acquire();
            try {
                synchronized (lock) {
                    if (stale()) return;
                    handle(link, m);
                }
            } finally {
                w.release();
            }
        }

        @Override
        public void onKeepalive() {
            synchronized (lock) {
                if (stale()) return;
                touch(link, clock.now(), false);
            }
        }

        @Override
        public void onClosed(NtfyException cause) {
            synchronized (lock) {
                if (stale()) return;
                link.call = null;
                closed(link, cause == null ? null : cause.kind());
                publishStatus();
            }
        }
    }

    /** Opens the link's stream from its cursor. Monitor held. */
    private void openStream(Link l) {
        l.generation++;
        l.waiting = false;
        l.state = LinkState.CONNECTING;
        try {
            l.call = ntfy.stream(l.server, l.topics, sinceFor(l), settings.allowHttp(),
                    new StreamListener(l, l.generation));
        } catch (IllegalArgumentException e) {
            // more topics than ntfy accepts, or a topic it would refuse
            l.call = null;
            closed(l, NtfyException.Kind.PROTOCOL);
        }
    }

    private void stop(Link l) {
        l.generation++;
        if (l.call != null) l.call.cancel();
        l.call = null;
        l.waiting = false;
    }

    private void reopen(Link l) {
        stop(l);
        l.attempt = 0;
        openStream(l);
    }

    /**
     * Schedules the reconnect of a closed stream: RECONNECT_MS[attempt] plus
     * jitter, attempt growing to the last value. A refusal no retry fixes
     * (token refused, access denied, cleartext refused here or by the
     * platform) waits the last value every time. Monitor held.
     */
    private void closed(Link l, NtfyException.Kind kind) {
        int last = RECONNECT_MS.length - 1;
        if (kind != null && isFatal(kind)) {
            l.fatal = true;
            l.attempt = last;
        }
        if (kind != null) l.reason = kind;
        l.state = kind == null ? LinkState.CONNECTING : LinkState.ERROR;
        long base = RECONNECT_MS[Math.min(l.attempt, last)];
        long delay = base + (long) (base * JITTER * random.nextDouble());
        l.attempt = Math.min(l.attempt + 1, last);
        l.waiting = true;
        l.generation++;
        final Link link = l;
        final int generation = l.generation;
        scheduler.schedule(new Runnable() {
            @Override
            public void run() {
                synchronized (lock) {
                    if (!realtime || generation != link.generation || links.get(link.url) != link) return;
                    openStream(link);
                }
            }
        }, delay);
    }

    private static boolean isFatal(NtfyException.Kind k) {
        return k == NtfyException.Kind.UNAUTHORIZED || k == NtfyException.Kind.FORBIDDEN
                || k == NtfyException.Kind.HTTP_REFUSED || k == NtfyException.Kind.CLEARTEXT_BLOCKED;
    }

    // ---- polls ----

    private void poll(Link l, boolean counting) {
        NtfyServer server;
        List<String> topics;
        String since;
        boolean http;
        synchronized (lock) {
            if (links.get(l.url) != l) return;
            server = l.server;
            topics = new ArrayList<>(l.topics);
            since = sinceFor(l);
            http = settings.allowHttp();
        }
        List<NtfyMessage> got = null;
        NtfyException.Kind failed = null;
        try {
            got = ntfy.poll(server, topics, since, http);
        } catch (NtfyException e) {
            failed = e.kind();
        } catch (IllegalArgumentException e) {
            failed = NtfyException.Kind.PROTOCOL;
        }
        List<String> silent = null;
        synchronized (lock) {
            long now = clock.now();
            // A failed poll counts as a poll: at POLL_60 the status of two failed runs comes with the
            // second failure, an hour after the first and two after the last success.
            settings.setEngineState("poll:" + l.url, Long.toString(now));
            if (got != null) {
                if (silentTooLong(l, now)) silent = new ArrayList<>(l.configIds);
                for (NtfyMessage m : got) handle(l, m);
                touch(l, now, true);
                if (!realtime) l.state = LinkState.POLLING;
                l.reason = null;
                clearFailures(ntfyKey(l.url));
            } else {
                if (!realtime) l.state = LinkState.ERROR;
                l.reason = failed;
                if (counting) addFailure(ntfyKey(l.url), failed.name());
            }
            for (String id : l.configIds) refreshStatus(id);
        }
        if (silent != null) {
            for (String id : silent) checkAccount(id, counting);
        }
    }

    private long lastPollAt(String url) {
        return parseLong(settings.engineState("poll:" + url));
    }

    // ---- the message path ----

    /** One ntfy message, streamed or polled. Monitor held. */
    private void handle(Link l, NtfyMessage m) {
        if (!"message".equals(m.event)) return;
        if (l.seen == null) l.seen = store.seen(l.url);
        if (!l.seen.add(m.id)) return;
        try {
            deliver(m);
        } catch (RuntimeException e) {
            // the platform cipher, a sealed key that no longer opens, or building or drawing failed
            faults++;
        } finally {
            // saved once handled: a death before this point replays the message rather than losing it
            long now = clock.now();
            store.saveSeen(l.url, l.seen);
            store.setCursor(l.url, m.id, now);
            l.contactAt = now;
            l.contactSavedAt = now;
        }
    }

    private void deliver(NtfyMessage m) {
        Subscription sub = store.byTopic(m.topic);
        if (sub == null) return;
        byte[] plain;
        try {
            plain = WebPushDecrypt.decrypt(m.body, sub.privateKey(), sub.publicKey, sub.authSecret);
        } catch (WebPushException e) {
            undecryptable++;
            return;
        }
        if (settings.foreground()) return;
        AccountView a = settings.account(sub.configId);
        if (a == null) return;
        PushPayload p;
        try {
            p = PushPayload.parse(plain);
        } catch (JSONException e) {
            undecryptable++;
            return;
        }
        PushStrings s = settings.strings();
        NotificationModel.Shown n = p.isChat() ? NotificationModel.chat(a, p, s) : NotificationModel.inbox(a, p, s);
        n.at = m.time * 1000L;
        notifier.show(n);
    }

    /**
     * The cursor, else the time contact was first recorded, in seconds: a
     * server never heard from is read from the moment the engine first saw a
     * subscription on it. Monitor held.
     */
    private String sinceFor(Link l) {
        String cursor = store.cursor(l.url);
        if (cursor != null) return cursor;
        return Long.toString(l.contactAt / 1000);
    }

    /** Whether the server was silent longer than it keeps messages. */
    private static boolean silentTooLong(Link l, long now) {
        return now - l.contactAt > l.server.cacheSeconds * 1000L;
    }

    /** Records contact; saved at once when forced, else at most every CONTACT_SAVE_MS. Monitor held. */
    private void touch(Link l, long now, boolean force) {
        l.contactAt = now;
        if (force || now - l.contactSavedAt >= CONTACT_SAVE_MS) {
            store.setCursor(l.url, store.cursor(l.url), now);
            l.contactSavedAt = now;
        }
    }

    // ---- Odoo direct ----

    /** Records a check owed to each account, kept across a stop or a death, and schedules it now. Monitor held. */
    private void oweChecks(List<String> configIds) {
        for (String id : configIds) settings.setEngineState("owe:" + id, "1");
        scheduler.schedule(new Runnable() {
            @Override
            public void run() {
                drainOwedChecks();
            }
        }, 0);
    }

    /**
     * Runs the checks owed to mirrored accounts; each is taken once. The
     * owed mark is cleared once the check ran, so a death during the check
     * leaves it owed to the next run.
     */
    private void drainOwedChecks() {
        List<String> owed = new ArrayList<>();
        synchronized (lock) {
            for (String id : mirroredIds()) {
                if (settings.engineState("owe:" + id) == null || !draining.add(id)) continue;
                owed.add(id);
            }
        }
        for (String id : owed) {
            try {
                checkAccount(id, false);
                synchronized (lock) {
                    settings.setEngineState("owe:" + id, null);
                }
            } finally {
                synchronized (lock) {
                    draining.remove(id);
                }
            }
        }
    }

    /**
     * Counts the account's unread messages in Odoo: the summary goes up
     * (alerting) on a rise, is updated silently on a drop, goes at 0; read
     * conversations lose their notification. An expired session is marked
     * and stops the checks until a new one is mirrored.
     */
    private void checkAccount(String configId, boolean counting) {
        NativeSession s;
        boolean http;
        synchronized (lock) {
            if (sessions.expired(configId)) return;
            s = sessions.get(configId);
            if (s == null) return;
            http = settings.allowHttp();
        }
        UnreadSummary u = null;
        OdooDirectException.Kind failed = null;
        try {
            u = odoo.check(s, http, clock.now());
        } catch (OdooDirectException e) {
            failed = e.kind();
        }
        synchronized (lock) {
            AccountState st = accounts.get(configId);
            if (st == null) {
                st = new AccountState();
                accounts.put(configId, st);
            }
            st.lastCheckAt = clock.now();
            st.ok = u != null;
            st.reason = failed;
            if (u != null) {
                clearFailures(accountKey(configId));
                applySummary(configId, u);
            } else if (failed == OdooDirectException.Kind.SESSION_EXPIRED) {
                sessions.markExpired(configId);
            } else if (counting) {
                addFailure(accountKey(configId), failed.name());
            }
            refreshStatus(configId);
        }
    }

    /** Monitor held. */
    private void applySummary(String configId, UnreadSummary u) {
        AccountView a = settings.account(configId);
        if (a == null) return;
        Set<String> drawn = notifier.shownTags();
        for (Long id : u.readChannelIds) {
            String tag = "chat:" + configId + ":" + id;
            if (drawn.contains(tag)) notifier.cancel(tag);
        }
        String tag = "summary:" + configId;
        int last = (int) parseLong(settings.engineState("sum:" + configId));
        boolean foreground = settings.foreground();
        if (u.total == 0) {
            if (last > 0 || drawn.contains(tag)) notifier.cancel(tag);
        } else if (u.total > last) {
            if (!foreground) notifier.show(NotificationModel.summary(a, u.total, settings.strings()));
        } else if (u.total < last && drawn.contains(tag) && !foreground) {
            NotificationModel.Shown n = NotificationModel.summary(a, u.total, settings.strings());
            n.silent = true;
            notifier.show(n);
        }
        settings.setEngineState("sum:" + configId, u.total == 0 ? null : Integer.toString(u.total));
    }

    /**
     * Sends every pending unregister with its account's session copy. An
     * account's entries are done when each one succeeded or Odoo knows
     * nothing of it; a removed account then loses its session copy too.
     */
    private void runPending() {
        List<PendingUnregister> all;
        boolean http;
        synchronized (lock) {
            all = sessions.pending();
            http = settings.allowHttp();
        }
        Map<String, List<PendingUnregister>> byAccount = new LinkedHashMap<>();
        for (PendingUnregister p : all) {
            List<PendingUnregister> list = byAccount.get(p.configId);
            if (list == null) {
                list = new ArrayList<>();
                byAccount.put(p.configId, list);
            }
            list.add(p);
        }
        for (Map.Entry<String, List<PendingUnregister>> e : byAccount.entrySet()) {
            String configId = e.getKey();
            NativeSession s;
            synchronized (lock) {
                s = sessions.expired(configId) ? null : sessions.get(configId);
            }
            if (s == null) continue;
            Set<String> sent = new HashSet<>();
            for (PendingUnregister p : e.getValue()) {
                try {
                    odoo.unregister(s, p.endpoint, http);
                    sent.add(p.endpoint);
                } catch (OdooDirectException ex) {
                    if (ex.kind() == OdooDirectException.Kind.NOT_FOUND) {
                        sent.add(p.endpoint);
                        continue;
                    }
                    if (ex.kind() == OdooDirectException.Kind.SESSION_EXPIRED) {
                        synchronized (lock) {
                            sessions.markExpired(configId);
                            refreshStatus(configId);
                        }
                    }
                    break;
                }
            }
            synchronized (lock) {
                if (!sent.isEmpty()) sessions.donePending(configId, sent);
                if (settings.account(configId) == null && !pendingAccounts().contains(configId)) {
                    sessions.forget(configId);
                }
            }
        }
        synchronized (lock) {
            forgetOrphanSessions();
        }
    }

    private Set<String> pendingAccounts() {
        Set<String> out = new HashSet<>();
        for (PendingUnregister p : sessions.pending()) out.add(p.configId);
        return out;
    }

    /**
     * Forgets the session copy of every account the last mirror left out
     * that has no endpoint left to unregister (none queued, all sent, or
     * expired). A copy saved after that mirror belongs to an account not
     * mirrored yet and stays. Nothing happens before a first mirror. Monitor
     * held.
     */
    private void forgetOrphanSessions() {
        long mirrorAt = parseLong(settings.engineState("mirrorAt"));
        if (mirrorAt <= 0) return;
        Set<String> live = mirroredIds();
        Set<String> waiting = pendingAccounts();
        for (String id : sessions.configIds()) {
            if (live.contains(id) || waiting.contains(id)) continue;
            NativeSession s = sessions.get(id);
            if (s == null || s.savedAt <= mirrorAt) sessions.forget(id);
        }
    }

    // ---- status notifications ----

    /**
     * Shows, replaces or removes the account's status notification: session
     * expired, else not listening once its ntfy or its Odoo check failed
     * FAILED_RUNS_FOR_STATUS runs in a row. What is shown is remembered, so
     * the same state is never posted twice. Monitor held.
     */
    private void refreshStatus(String configId) {
        AccountView a = settings.account(configId);
        String key = "status:" + configId;
        if (a == null) {
            settings.setEngineState(key, null);
            return;
        }
        PushStrings s = settings.strings();
        String want = null;
        String text = null;
        if (sessions.expired(configId)) {
            want = "session_expired";
            text = s.format("status_session_expired", Collections.singletonMap("server", a.label));
        } else {
            String reasonKey = null;
            if (failures(accountKey(configId)) >= FAILED_RUNS_FOR_STATUS) {
                reasonKey = odooReasonKey(failureKind(accountKey(configId)));
            }
            Link l = linkOf(configId);
            if (l != null && failures(ntfyKey(l.url)) >= FAILED_RUNS_FOR_STATUS) {
                reasonKey = "reason_" + failureKind(ntfyKey(l.url)).toLowerCase(Locale.ROOT);
            }
            if (reasonKey != null) {
                want = "not_listening:" + reasonKey;
                Map<String, String> vars = new HashMap<>();
                vars.put("server", a.label);
                vars.put("reason", s.get(reasonKey));
                text = s.format("status_not_listening", vars);
            }
        }
        String had = settings.engineState(key);
        if (Objects.equals(want, had)) return;
        if (want == null) {
            notifier.cancel("status:" + configId);
        } else {
            notifier.show(NotificationModel.status(a, text));
        }
        settings.setEngineState(key, want);
    }

    private static String odooReasonKey(String kind) {
        if ("UNREACHABLE".equals(kind)) return "reason_odoo_unreachable";
        if ("NOT_FOUND".equals(kind) || kind.isEmpty()) return "reason_protocol";
        return "reason_" + kind.toLowerCase(Locale.ROOT);
    }

    private static String ntfyKey(String url) {
        return "fail:ntfy:" + url;
    }

    private static String accountKey(String configId) {
        return "fail:acct:" + configId;
    }

    /** Failed runs in a row, stored as "&lt;count&gt;:&lt;kind&gt;". */
    private int failures(String key) {
        String v = settings.engineState(key);
        if (v == null) return 0;
        int colon = v.indexOf(':');
        return (int) parseLong(colon < 0 ? v : v.substring(0, colon));
    }

    private String failureKind(String key) {
        String v = settings.engineState(key);
        int colon = v == null ? -1 : v.indexOf(':');
        return colon < 0 ? "" : v.substring(colon + 1);
    }

    private void addFailure(String key, String kind) {
        settings.setEngineState(key, (failures(key) + 1) + ":" + kind);
    }

    private void clearFailures(String key) {
        settings.setEngineState(key, null);
    }

    // ---- links and accounts ----

    /**
     * Aligns the links with the ntfy servers that have subscriptions: topics
     * sorted, a server first seen gets its contact time recorded (the start
     * of its reading when it has no cursor). While realtime, a new link, a
     * changed token or topic set, or every link when reopenAll, is reopened.
     * Returns the links reopened. Monitor held.
     */
    private Set<Link> syncLinks(boolean reopenAll) {
        Map<String, Link> wanted = new LinkedHashMap<>();
        List<Link> toOpen = new ArrayList<>();
        long now = clock.now();
        for (NtfyServer s : store.ntfys()) {
            List<Subscription> subs = store.subscriptions(s.url);
            if (subs.isEmpty()) continue;
            List<String> topics = new ArrayList<>();
            List<String> ids = new ArrayList<>();
            for (Subscription sub : subs) {
                topics.add(sub.topic);
                ids.add(sub.configId);
            }
            Collections.sort(topics);
            Collections.sort(ids);
            Link l = links.get(s.url);
            boolean changed;
            if (l == null) {
                l = new Link(s.url);
                long at = store.lastContactAt(s.url);
                if (store.cursor(s.url) == null && at <= 0) {
                    at = now;
                    store.setCursor(s.url, null, at);
                }
                l.contactAt = at;
                l.contactSavedAt = at;
                changed = true;
            } else {
                changed = !Objects.equals(s.token, l.server.token) || !topics.equals(l.topics);
            }
            l.server = s;
            l.topics = topics;
            l.configIds = ids;
            wanted.put(s.url, l);
            if (realtime && (changed || reopenAll)) toOpen.add(l);
        }
        for (Link old : links.values()) {
            if (!wanted.containsKey(old.url)) {
                stop(old);
                settings.setEngineState("poll:" + old.url, null);
                clearFailures(ntfyKey(old.url));
            }
        }
        links.clear();
        links.putAll(wanted);
        for (Link l : toOpen) reopen(l);
        return new HashSet<>(toOpen);
    }

    /** The link carrying the account's topic, or null when the account has no usable ntfy. Monitor held. */
    private Link linkOf(String configId) {
        for (Link l : links.values()) {
            if (l.configIds.contains(configId)) return l;
        }
        return null;
    }

    private Set<String> mirroredIds() {
        Set<String> out = new HashSet<>();
        for (AccountView a : settings.accounts()) out.add(a.configId);
        return out;
    }

    private void forgetAccount(String configId) {
        accounts.remove(configId);
        settings.setEngineState("sum:" + configId, null);
        settings.setEngineState("status:" + configId, null);
        settings.setEngineState("owe:" + configId, null);
        clearFailures(accountKey(configId));
    }

    private static final String[] TAG_PREFIXES = {"chat:", "inbox:", "summary:", "status:"};

    private static boolean isEngineTag(String tag) {
        if (tag == null) return false;
        for (String p : TAG_PREFIXES) {
            if (tag.startsWith(p)) return true;
        }
        return false;
    }

    /** Whether the tag ("&lt;kind&gt;:&lt;configId&gt;[:...]") belongs to one of the accounts. */
    private static boolean ownedBy(String tag, Set<String> configIds) {
        String rest = tag.substring(tag.indexOf(':') + 1);
        for (String id : configIds) {
            if (rest.equals(id) || rest.startsWith(id + ":")) return true;
        }
        return false;
    }

    // ---- health ----

    private void publishStatus() {
        notifier.status(snapshot());
    }

    /** Monitor held. */
    private HealthSnapshot snapshot() {
        long now = clock.now();
        int level = settings.level();
        PushLevelPolicy.Effective e = effective != null ? effective
                : PushLevelPolicy.resolve(level, new PushLevelPolicy.PowerState(false, false, false, 100),
                        realtimeBuild, PushLevelPolicy.NO_CLIMB);
        boolean polling = e.mode == PushLevelPolicy.Mode.POLL_15 || e.mode == PushLevelPolicy.Mode.POLL_60;
        List<HealthSnapshot.Ntfy> ns = new ArrayList<>();
        for (Link l : links.values()) {
            ns.add(new HealthSnapshot.Ntfy(l.url, stateOf(l, polling, now), lower(l.reason), l.contactAt,
                    new ArrayList<>(l.configIds)));
        }
        List<HealthSnapshot.Account> as = new ArrayList<>();
        for (AccountView a : settings.accounts()) as.add(accountHealth(a.configId, polling, now));
        String mode = realtime ? "realtime" : e.mode.name().toLowerCase(Locale.ROOT);
        boolean alive = e.permanentService && now - settings.lastBeat() < BEAT_MAX_AGE_MS;
        return new HealthSnapshot(now, level, e.level, mode, realtimeBuild, alive, ns, as, undecryptable,
                faults);
    }

    /** A connected stream silent for STALE_CONTACT_MS on the wall clock. Monitor held. */
    private static boolean stale(Link l, long now) {
        return l.state == LinkState.CONNECTED && now - l.contactAt > STALE_CONTACT_MS;
    }

    /** A stale stream reads as connecting: it is not counted as listening. */
    private String stateOf(Link l, boolean polling, long now) {
        if (realtime && stale(l, now)) return "connecting";
        if (realtime) return l.state == LinkState.POLLING ? "connecting" : l.state.name().toLowerCase(Locale.ROOT);
        if (l.state == LinkState.ERROR) return "error";
        return polling ? "polling" : "off";
    }

    private HealthSnapshot.Account accountHealth(String configId, boolean polling, long now) {
        AccountState st = accounts.get(configId);
        long checkedAt = st == null ? 0L : st.lastCheckAt;
        Link l = linkOf(configId);
        String via = l != null ? "ntfy" : "odoo";
        if (sessions.expired(configId)) {
            return new HealthSnapshot.Account(configId, via, "session_expired", "session_expired", checkedAt);
        }
        if (l != null) {
            String state;
            String ls = stateOf(l, polling, now);
            if ("connected".equals(ls) || "polling".equals(ls)) state = "ok";
            else if ("error".equals(ls)) state = "error";
            else state = "waiting";
            return new HealthSnapshot.Account(configId, via, state, lower(l.reason), checkedAt);
        }
        if (sessions.get(configId) == null) {
            return new HealthSnapshot.Account(configId, via, "no_session", null, checkedAt);
        }
        if (st == null) return new HealthSnapshot.Account(configId, via, "waiting", null, checkedAt);
        return new HealthSnapshot.Account(configId, via, st.ok ? "ok" : "error", lower(st.reason), checkedAt);
    }

    private static String lower(Enum<?> e) {
        return e == null ? null : e.name().toLowerCase(Locale.ROOT);
    }

    private static long parseLong(String v) {
        if (v == null) return 0L;
        try {
            return Long.parseLong(v);
        } catch (NumberFormatException e) {
            return 0L;
        }
    }
}
