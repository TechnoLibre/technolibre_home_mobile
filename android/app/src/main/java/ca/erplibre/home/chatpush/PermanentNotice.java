package ca.erplibre.home.chatpush;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import ca.erplibre.home.SmsGatewayService;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/**
 * The one permanent notification of the app (id ID on channel CHANNEL,
 * importance MIN), shared by the foreground services that need one: the
 * SMS gateway and the chat push service. Its text is built from whoever
 * holds it, so the user sees one notification however many of them run.
 *
 * Each holder calls startForeground with the same id. A holder that
 * releases while another still holds detaches the notification
 * (STOP_FOREGROUND_DETACH) and the other re-asserts startForeground with
 * the text left: a detached notification loses its foreground flag, and
 * the re-assertion gives it back. The last one to release removes it.
 *
 * Android 12 and later may refuse startForeground to an app in the
 * background (ForegroundServiceStartNotAllowedException, an
 * IllegalStateException). A refused hold is undone and reported to the
 * caller, which stops; a refused re-assertion falls back to a plain post of
 * the text left, the remaining service keeping the foreground state it
 * already had. Only the exception class is logged.
 *
 * Every method is safe from any thread; all run under one lock, and none
 * calls back into a holder.
 */
public final class PermanentNotice {

    public enum Holder { SMS, CHAT }

    static final int ID = 9101;
    static final String CHANNEL = "erplibre_permanent";
    /** The channel the SMS gateway posted on before this class; deleted on first post. */
    static final String OLD_SMS_CHANNEL = "erplibre_sms_gateway";

    private static final String TAG = "PermanentNotice";
    private static final Object LOCK = new Object();
    private static final State STATE = new State();
    private static final Map<Holder, Service> SERVICES = new EnumMap<>(Holder.class);
    private static boolean channelReady;

    private PermanentNotice() {}

    /**
     * Makes s a foreground service holding the notice with line, and draws
     * the combined text. A service that already holds only updates its line.
     * Returns false when Android refuses the foreground start: nothing is
     * held then, and the caller is expected to stop.
     */
    public static boolean hold(final Service s, Holder h, String line) {
        synchronized (LOCK) {
            String refusal = hold(STATE, SERVICES, s, h, line, (svc, held) -> {
                Notification n = build(svc);
                if (held) notify(svc, n);
                else startForeground(svc, n);
            });
            if (refusal == null) return true;
            Log.w(TAG, "hold refused: " + refusal);
            return false;
        }
    }

    /** Draws the notice for s: a plain post when s already held it, else a foreground start that may throw. */
    interface Poster<S> {
        void post(S s, boolean held);
    }

    /**
     * The decision of hold(), apart from Android: records h's line and
     * service, then posts. A refused foreground start (IllegalStateException)
     * of a service not yet holding is undone, service and line, and its
     * class name returned; null when the hold went through.
     */
    static <S> String hold(State st, Map<Holder, S> services, final S s, Holder h, String line,
            final Poster<S> poster) {
        boolean held = services.get(h) == s;
        st.hold(h, line);
        services.put(h, s);
        if (held) {
            poster.post(s, true);
            return null;
        }
        String refusal = tryForeground(() -> poster.post(s, false), null);
        if (refusal != null) {
            services.remove(h);
            st.release(h);
        }
        return refusal;
    }

    /** Replaces the line of h while s holds the notice; a service that no longer holds it changes nothing. */
    public static void update(Service s, Holder h, String line) {
        synchronized (LOCK) {
            if (SERVICES.get(h) != s) return;
            String l = line == null ? "" : line;
            if (l.equals(STATE.line(h))) return;
            STATE.hold(h, l);
            notify(s, build(s));
        }
    }

    /**
     * Drops s's hold. The other holder, if any, re-asserts the notice with
     * its own text; else the notice goes. A service that does not hold it
     * changes nothing.
     */
    public static void release(Service s, Holder h) {
        synchronized (LOCK) {
            if (SERVICES.get(h) != s) return;
            SERVICES.remove(h);
            Holder other = STATE.release(h);
            if (other == null) {
                stopForeground(s, true);
                NotificationManager m = s.getSystemService(NotificationManager.class);
                if (m != null) m.cancel(ID);
                return;
            }
            stopForeground(s, false);
            final Service o = SERVICES.get(other);
            if (o == null) return;
            final Notification n = build(o);
            String refusal = tryForeground(() -> startForeground(o, n), () -> notify(o, n));
            if (refusal != null) Log.w(TAG, "re-assertion refused, notice posted: " + refusal);
        }
    }

    /**
     * Runs start; when it throws an IllegalStateException (a foreground start
     * Android refuses), runs fallback if any and returns the exception's
     * class name. Null when start went through. Other exceptions propagate.
     */
    static String tryForeground(Runnable start, Runnable fallback) {
        try {
            start.run();
            return null;
        } catch (IllegalStateException e) {
            if (fallback != null) fallback.run();
            return e.getClass().getSimpleName();
        }
    }

    private static void startForeground(Service s, Notification n) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            s.startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            s.startForeground(ID, n);
        }
    }

    private static void stopForeground(Service s, boolean remove) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            s.stopForeground(remove ? Service.STOP_FOREGROUND_REMOVE : Service.STOP_FOREGROUND_DETACH);
        } else {
            s.stopForeground(remove);
        }
    }

    private static void notify(Context c, Notification n) {
        NotificationManager m = c.getSystemService(NotificationManager.class);
        if (m != null) m.notify(ID, n);
    }

    /** Lock held. */
    private static Notification build(Context c) {
        ensureChannel(c);
        List<String> lines = STATE.lines();
        String text = String.join(" · ", lines);
        boolean smsOnly = STATE.holds(Holder.SMS) && !STATE.holds(Holder.CHAT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
                .setContentTitle(STATE.title())
                .setContentText(text)
                .setSmallIcon(smsOnly ? android.R.drawable.stat_sys_upload : android.R.drawable.stat_notify_chat)
                .setOngoing(true)
                .setSilent(true)
                .setShowWhen(false)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setPriority(NotificationCompat.PRIORITY_MIN);
        if (lines.size() > 1) b.setStyle(new NotificationCompat.BigTextStyle().bigText(String.join("\n", lines)));
        Intent launch = c.getPackageManager().getLaunchIntentForPackage(c.getPackageName());
        if (launch != null) {
            b.setContentIntent(PendingIntent.getActivity(c, ID, launch,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        }
        Service sms = SERVICES.get(Holder.SMS);
        if (sms != null) {
            Intent stop = new Intent(sms, sms.getClass()).setAction(SmsGatewayService.ACTION_STOP);
            PendingIntent stopPending = PendingIntent.getService(sms, 1, stop,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            b.addAction(android.R.drawable.ic_menu_close_clear_cancel, "Arrêter", stopPending);
        }
        return b.build();
    }

    /**
     * Creates the shared channel, named by the mirrored channel_permanent
     * string, once per process, and deletes the SMS gateway's former channel.
     * Importance is fixed at creation: Android keeps what the user set later.
     */
    private static void ensureChannel(Context c) {
        if (channelReady || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager m = c.getSystemService(NotificationManager.class);
        if (m == null) return;
        try {
            if (m.getNotificationChannel(OLD_SMS_CHANNEL) != null) m.deleteNotificationChannel(OLD_SMS_CHANNEL);
            if (m.getNotificationChannel(CHANNEL) == null) {
                String name = new PushSettingsStore(new PrefsKeyValue(c, ChatPushRuntime.SETTINGS_FILE))
                        .strings().get("channel_permanent");
                NotificationChannel ch = new NotificationChannel(CHANNEL, name, NotificationManager.IMPORTANCE_MIN);
                ch.setShowBadge(false);
                m.createNotificationChannel(ch);
            }
            channelReady = true;
        } catch (RuntimeException e) {
            // the notification service can be unreachable while the system restarts it; retried next post
            Log.w(TAG, "channel not ready: " + e.getClass().getSimpleName());
        }
    }

    /**
     * Who holds the notice and with which line, and the text drawn from
     * that. Lines are in Holder order; with more than one holder the SMS
     * gateway's line is prefixed by its name, the chat line naming its own
     * state.
     */
    static final class State {

        private final EnumMap<Holder, String> lines = new EnumMap<>(Holder.class);

        void hold(Holder h, String line) {
            lines.put(h, line == null ? "" : line);
        }

        /** Drops h; returns the holder that must re-assert the notice, or null when none is left or h did not hold. */
        Holder release(Holder h) {
            if (lines.remove(h) == null) return null;
            return lines.isEmpty() ? null : lines.keySet().iterator().next();
        }

        boolean holds(Holder h) {
            return lines.containsKey(h);
        }

        String line(Holder h) {
            return lines.get(h);
        }

        String title() {
            if (lines.isEmpty()) return "";
            if (lines.size() == 1 && holds(Holder.SMS)) return "Passerelle SMS ERPLibre";
            return "ERPLibre";
        }

        /** A holder whose line is still empty (its first hold, before its state is known) adds none. */
        List<String> lines() {
            List<String> out = new ArrayList<>();
            boolean several = lines.size() > 1;
            for (Map.Entry<Holder, String> e : lines.entrySet()) {
                if (e.getValue().isEmpty()) continue;
                out.add(several && e.getKey() == Holder.SMS ? "Passerelle SMS : " + e.getValue() : e.getValue());
            }
            return out;
        }

        boolean empty() {
            return lines.isEmpty();
        }
    }
}
