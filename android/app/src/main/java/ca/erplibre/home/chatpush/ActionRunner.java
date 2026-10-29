package ca.erplibre.home.chatpush;

import java.nio.charset.StandardCharsets;
import java.util.function.LongSupplier;

/**
 * Runs one stored action to its end state on the session's native copy. Each attempt claims the record,
 * then asks Odoo whether the session is alive (the action routes are auth="public" and would run as the
 * public user), then acts:
 * - reply: with the module, posted with its uuid, which makes a resend return the first message; without
 *   it, a reply that may already have reached Odoo (sentAt) waits out ActionStore.QUIET_MS from that send,
 *   then searches its marker first and posts only when none is found. The send is stamped before the call.
 * - read: up to the record's message id, else the newest message dated at most its bound, then marked.
 * - mute: for the minutes left until createdAt + 1 h; none left is done without a call.
 * - 👍: on the record's message id.
 * A transient failure (TRANSIENT, UNREACHABLE) retries with a backoff until the action is
 * ActionStore.STALE_MS old; a dead session, two marker hits or any other failure hand the action to the
 * app. A JSON-RPC 404 on an action route asks alive again: dead is a dead session, alive a refusal. An
 * action of an account no longer mirrored is done without an answer. Nothing here logs.
 */
final class ActionRunner {

    enum Outcome { DONE, RETRY, HANDOFF, SKIPPED }

    static final String SESSION_EXPIRED = "session_expired";
    static final String REFUSED = "refused";
    static final String AMBIGUOUS = "ambiguous";
    static final String STALE = "stale";

    private static final long MUTE_MS = 3_600_000L;

    private final ActionStore store;
    private final NativeSessions sessions;
    private final PushSettingsStore settings;
    private final OdooActions odoo;
    private final LongSupplier clock;

    ActionRunner(ActionStore store, NativeSessions sessions, PushSettingsStore settings, OdooActions odoo,
            LongSupplier clock) {
        this.store = store;
        this.sessions = sessions;
        this.settings = settings;
        this.odoo = odoo;
        this.clock = clock;
    }

    /** One attempt of the action; SKIPPED when it is absent or not PENDING (another run holds it). */
    Outcome run(String id) {
        if (!store.claim(id)) return Outcome.SKIPPED;
        ChatAction a = store.get(id);
        if (a == null) return Outcome.SKIPPED;
        try {
            return attempt(a);
        } catch (RuntimeException e) {
            // Retried as a transient failure: the record never stays RUNNING in a live process
            return retryOrStale(a);
        }
    }

    /** Forgets the old DONE records, then runs every due record, oldest first. */
    void runDue() {
        store.prune();
        for (ChatAction a : store.due()) run(a.id);
    }

    private Outcome attempt(ChatAction a) {
        AccountView account = settings.account(a.configId);
        if (account == null) {
            store.done(a.id, null);
            return Outcome.DONE;
        }
        int minutes = a.kind == ActionKind.MUTE ? minutesLeft(a) : 0;
        if (a.kind == ActionKind.MUTE && minutes <= 0) {
            store.done(a.id, null);
            return Outcome.DONE;
        }
        NativeSession s = sessions.get(a.configId);
        if (s == null || sessions.expired(a.configId)) return handoff(a, SESSION_EXPIRED);
        boolean allowHttp = settings.allowHttp();
        long self;
        try {
            self = odoo.alive(s, allowHttp);
        } catch (OdooDirectException e) {
            return failed(a, e);
        }
        try {
            return act(a, account, s, self, minutes, allowHttp);
        } catch (OdooDirectException e) {
            if (e.kind() != OdooDirectException.Kind.NOT_FOUND || !e.rpc()) return failed(a, e);
            try {
                odoo.alive(s, allowHttp);
            } catch (OdooDirectException again) {
                return failed(a, again);
            }
            return handoff(a, REFUSED);
        }
    }

    private Outcome act(ChatAction a, AccountView account, NativeSession s, long self, int minutes,
            boolean allowHttp) throws OdooDirectException {
        switch (a.kind) {
            case REPLY: {
                boolean module = !account.module.isEmpty();
                if (!module && a.sentAt > 0) {
                    long now = clock.getAsLong();
                    if (a.sentAt > now) {
                        // Stamped under a clock that ran fast: the window restarts once, now
                        store.markSent(a.id);
                        store.retryAt(a.id, now + ActionStore.QUIET_MS);
                        return Outcome.RETRY;
                    }
                    if (now < a.sentAt + ActionStore.QUIET_MS) {
                        store.retryAt(a.id, a.sentAt + ActionStore.QUIET_MS);
                        return Outcome.RETRY;
                    }
                    if (odoo.findSent(s, a.channelId, a.clientUuid, self, allowHttp) != null) {
                        store.done(a.id, null);
                        return Outcome.DONE;
                    }
                }
                store.markSent(a.id);
                Posted p = odoo.post(s, a.channelId, ReplyBody.of(a.text, a.clientUuid), a.clientUuid, module,
                        allowHttp);
                store.done(a.id, p.answer);
                return Outcome.DONE;
            }
            case READ: {
                long last = a.messageId;
                if (last <= 0) {
                    Long latest = odoo.latestMessageId(s, a.channelId, a.atMostS, allowHttp);
                    if (latest == null) {
                        store.done(a.id, null);
                        return Outcome.DONE;
                    }
                    last = latest;
                }
                odoo.markRead(s, a.channelId, last, allowHttp);
                store.done(a.id, null);
                return Outcome.DONE;
            }
            case MUTE:
                odoo.mute(s, a.channelId, minutes, allowHttp);
                store.done(a.id, null);
                return Outcome.DONE;
            case REACT: {
                String answer = odoo.react(s, a.messageId, a.content, allowHttp);
                boolean kept = answer.getBytes(StandardCharsets.UTF_8).length <= OdooActions.MAX_ANSWER_BYTES;
                store.done(a.id, kept ? answer : null);
                return Outcome.DONE;
            }
            default:
                return handoff(a, REFUSED);
        }
    }

    /** Whole minutes left until createdAt + 1 h, never past it. */
    private int minutesLeft(ChatAction a) {
        long left = a.createdAt + MUTE_MS - clock.getAsLong();
        return left <= 0 ? 0 : (int) Math.min(60, left / 60_000L);
    }

    private Outcome failed(ChatAction a, OdooDirectException e) {
        switch (e.kind()) {
            case SESSION_EXPIRED:
                sessions.markExpired(a.configId);
                return handoff(a, SESSION_EXPIRED);
            case TRANSIENT:
            case UNREACHABLE:
                return retryOrStale(a);
            case AMBIGUOUS:
                return handoff(a, AMBIGUOUS);
            default:
                return handoff(a, REFUSED);
        }
    }

    private Outcome retryOrStale(ChatAction a) {
        if (clock.getAsLong() - a.createdAt >= ActionStore.STALE_MS) return handoff(a, STALE);
        store.retryLater(a.id);
        return Outcome.RETRY;
    }

    private Outcome handoff(ChatAction a, String reason) {
        store.handoff(a.id, reason);
        return Outcome.HANDOFF;
    }
}
