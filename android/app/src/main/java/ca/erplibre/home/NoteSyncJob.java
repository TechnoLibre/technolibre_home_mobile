package ca.erplibre.home;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * Signale, app fermée, les notes qui attendent la synchronisation Odoo.
 *
 * <p>La synchronisation elle-même ne tourne que dans l'application : toute sa
 * logique (file d'opérations, fusion, conflits) vit dans la vue web, avec la
 * base et les identifiants chiffrés. Ce travail ne la refait pas. Il lit ce que
 * l'application a publié en passant en arrière-plan (voir {@link NoteSyncPlugin})
 * et, s'il reste du travail et que le réseau est là, affiche une notification
 * qui rouvre l'application : sa reprise synchronise ce qui est dû.
 *
 * <p>Comme {@link SmsWatchdogJob}, c'est un travail planifié du système : il
 * survit à la mort du processus et, persisté, aux redémarrages. Quinze minutes
 * est le plancher d'Android pour un travail périodique ; la contrainte réseau
 * évite d'annoncer une synchronisation qui ne pourrait pas avoir lieu.
 */
public class NoteSyncJob extends JobService {

    private static final String TAG = "NoteSyncJob";

    /** Identifiant stable : replanifier ne crée pas de doublon. Distinct de celui de la passerelle. */
    private static final int JOB_ID = 4822;

    private static final long PERIOD_MS = 15 * 60 * 1000L;

    static final String PREFS = "erplibre_note_sync";
    static final String KEY_PENDING = "pending";
    static final String KEY_CONFLICTS = "conflicts";
    static final String KEY_FOREGROUND = "foreground";
    static final String KEY_TITLE = "title";
    static final String KEY_BODY = "body";

    private static final String CHANNEL_ID = "note_sync";
    static final int NOTIF_ID = 4822;

    /** Installe le travail périodique. Sans effet s'il est déjà en place. */
    public static void schedule(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler == null || scheduler.getPendingJob(JOB_ID) != null) {
            return;
        }
        JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(context, NoteSyncJob.class))
                .setPeriodic(PERIOD_MS)
                .setPersisted(true)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .build();
        try {
            scheduler.schedule(job);
        } catch (IllegalArgumentException | IllegalStateException e) {
            // Un quota de travaux atteint : on perd l'avertissement, pas la synchronisation
            Log.w(TAG, "Travail impossible à planifier", e);
        }
    }

    /** Retire la notification, quand l'application est au premier plan ou n'a plus rien en attente. */
    public static void clear(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.cancel(NOTIF_ID);
        }
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        int pending = prefs.getInt(KEY_PENDING, 0);
        int conflicts = prefs.getInt(KEY_CONFLICTS, 0);
        // Au premier plan, l'application synchronise elle-même ; sans travail, rien à dire
        if (prefs.getBoolean(KEY_FOREGROUND, false) || pending + conflicts == 0) {
            clear(this);
            return false;
        }
        notifyPending(prefs);
        return false;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        // Rien à reprendre : le prochain réveil reconstruit la notification
        return false;
    }

    private void notifyPending(SharedPreferences prefs) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && manager.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "Synchronisation des notes", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Notes en attente d'envoi vers Odoo.");
            manager.createNotificationChannel(channel);
        }
        Intent open = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(
                this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        // Textes publiés par l'application, dans sa langue ; un défaut si elle n'en a donné aucun
        String title = prefs.getString(KEY_TITLE, "Notes en attente de synchronisation");
        String body = prefs.getString(KEY_BODY, "Ouvrez l'application pour les envoyer.");
        manager.notify(NOTIF_ID, new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentIntent(tap)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build());
    }
}
