package ca.erplibre.home;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.AlarmManager;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.BatteryManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.telephony.SmsManager;
import android.telephony.TelephonyManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Service au premier plan qui fait fonctionner la passerelle SMS.
 *
 * <h3>Le téléphone interroge, le serveur ne le joint jamais</h3>
 *
 * <p>Toutes les minutes environ, le service demande au serveur Odoo s'il y a des
 * SMS à envoyer, en HTTPS sortant. L'appareil peut donc vivre derrière une IP
 * dynamique et un NAT d'opérateur — le cas d'une connexion résidentielle
 * ordinaire — sans tunnel, sans port ouvert et sans infrastructure
 * intermédiaire.
 *
 * <p>Chaque interrogation porte aussi l'état de la passerelle : elle vaut donc
 * signal de vie. Une passerelle qui n'interroge plus est hors service, par
 * définition, et le serveur le détecte sans mécanisme supplémentaire.
 *
 * <h3>Type de service : specialUse, et non dataSync</h3>
 *
 * <p>Android 15 plafonne les services de type {@code dataSync} à six heures par
 * période de vingt-quatre heures. Une passerelle d'alerte doit tourner en
 * permanence : {@code specialUse} n'est pas soumis à ce plafond. L'application
 * n'étant pas distribuée par Google Play, la justification que Play exigerait
 * pour ce type ne s'applique pas.
 *
 * <h3>Pourquoi une alarme, et non une boucle qui dort</h3>
 *
 * <p>{@code Thread.sleep()} se cadence sur {@code SystemClock.uptimeMillis},
 * <strong>qui s'arrête quand l'appareil se suspend</strong> — et un service au
 * premier plan ne tient aucun wakelock. Une boucle qui dort dériverait donc dès
 * l'écran éteint : elle demanderait soixante secondes et se réveillerait après
 * douze minutes.
 *
 * <p>Le rythme vient donc d'une alarme {@code ELAPSED_REALTIME_WAKEUP}, seule
 * horloge qui continue de compter pendant la suspension, réarmée à la fin de
 * chaque cycle. Un wakelock court est tenu le temps du cycle, jamais en
 * permanence : un wakelock permanent est précisément ce qui déclenche les
 * tueurs d'applications de Huawei et de Samsung.
 *
 * <p>À noter pour le cas nominal : un appareil <strong>branché</strong> n'entre
 * jamais en Doze — vérifié dans {@code DeviceIdleController}, où {@code mCharging}
 * bloque la bascule. Le soin apporté ici sert surtout la panne de courant, moment
 * où une annulation doit justement pouvoir partir.
 *
 * <h3>Ce qui garantit qu'aucun SMS ne se perd</h3>
 *
 * <p>Le serveur ne considère un travail comme livré que lorsque le téléphone en
 * a confirmé l'envoi. Un travail remis mais jamais confirmé — téléphone mort
 * entre la réception et l'enregistrement — est reproposé après un délai. La
 * file locale étant indexée par l'identifiant du SMS, un doublon est ignoré.
 */
public class SmsGatewayService extends Service {

    private static final String TAG = "SmsGatewayService";

    private static final String CHANNEL_ID = "erplibre_sms_gateway";
    private static final int NOTIF_ID = 9101;

    public static final String ACTION_STOP = "ca.erplibre.home.SMS_GATEWAY_STOP";
    public static final String ACTION_KICK = "ca.erplibre.home.SMS_GATEWAY_KICK";
    /** Action interne de l'alarme qui cadence les cycles. */
    private static final String ACTION_CYCLE = "ca.erplibre.home.SMS_GATEWAY_CYCLE";
    private static final int ALARM_REQUEST_CODE = 9102;
    /** Garde-fou : un wakelock ne doit jamais fuir au-delà de cette durée. */
    private static final long WAKELOCK_TIMEOUT_MS = 90_000L;

    /** Intervalle minimal entre deux remises à SmsManager. */
    private static final long MIN_SEND_INTERVAL_MS = 2_500L;
    /** Recul après une interrogation ratée, pour ne pas marteler un serveur à terre. */
    private static final long[] RETRY_BACKOFF_MS = {5_000L, 15_000L, 30_000L, 60_000L, 120_000L};

    /** Visible du plugin : évite de démarrer deux fois et renseigne l'interface. */
    static volatile boolean running = false;
    /** Vrai tant que la dernière interrogation a abouti. */
    static volatile boolean connected = false;
    static volatile String lastSubscriptionError = "";
    static volatile long lastPollAt = 0L;

    private final AtomicBoolean stopRequested = new AtomicBoolean(false);
    private SmsGatewayConfig config;
    private SmsOutbox outbox;
    private SmsJournal journal;
    /** Voir l'usage : évite de rejournaliser un état qui ne change pas. */
    private static boolean exactAlarmsReported = false;
    private OdooReporter reporter;
    private SmsResultReceiver resultReceiver;
    private ExecutorService worker;
    private AlarmManager alarmManager;
    private PowerManager powerManager;
    private BroadcastReceiver cycleReceiver;
    private ConnectivityManager.NetworkCallback networkCallback;
    private long lastSendAt = 0L;
    private int consecutiveFailures = 0;

    // ------------------------------------------------------------------
    public static void start(Context context) {
        Intent intent = new Intent(context, SmsGatewayService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    public static void stop(Context context) {
        Intent intent = new Intent(context, SmsGatewayService.class);
        intent.setAction(ACTION_STOP);
        context.startService(intent);
    }

    public static void kick(Context context) {
        Intent intent = new Intent(context, SmsGatewayService.class);
        intent.setAction(ACTION_KICK);
        context.startService(intent);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        config = new SmsGatewayConfig(this);
        outbox = SmsOutbox.get(this);
        journal = new SmsJournal(this);
        reporter = new OdooReporter(this);
        alarmManager = getSystemService(AlarmManager.class);
        powerManager = getSystemService(PowerManager.class);
        worker = Executors.newSingleThreadExecutor();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;

        if (ACTION_STOP.equals(action)) {
            Log.i(TAG, "Arrêt demandé");
            stopRequested.set(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (!config.isConfigured()) {
            Log.w(TAG, "Passerelle non configurée, arrêt");
            journal.warn(SmsJournal.CAT_CONFIG, "Passerelle non configurée, arrêt du service", null);
            stopSelf();
            return START_NOT_STICKY;
        }

        startForegroundCompat();

        if (running) {
            if (ACTION_KICK.equals(action)) {
                // Ne pas attendre la prochaine alarme : l'utilisatrice vient
                // d'agir, elle attend un effet immédiat.
                triggerCycle();
            }
            return START_STICKY;
        }
        running = true;
        stopRequested.set(false);
        registerResultReceiver();
        registerCycleReceiver();
        registerNetworkCallback();
        triggerCycle();

        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "Service détruit");
        stopRequested.set(true);
        running = false;
        connected = false;
        cancelAlarm();
        unregister(resultReceiver);
        resultReceiver = null;
        unregister(cycleReceiver);
        cycleReceiver = null;
        if (networkCallback != null) {
            try {
                ConnectivityManager connectivity = getSystemService(ConnectivityManager.class);
                if (connectivity != null) {
                    connectivity.unregisterNetworkCallback(networkCallback);
                }
            } catch (IllegalArgumentException ignored) {
                // Déjà retiré.
            }
            networkCallback = null;
        }
        if (worker != null) {
            worker.shutdownNow();
            worker = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** Retire un récepteur sans se soucier de savoir s'il l'était déjà. */
    private void unregister(BroadcastReceiver receiver) {
        if (receiver == null) {
            return;
        }
        try {
            unregisterReceiver(receiver);
        } catch (IllegalArgumentException ignored) {
            // Déjà retiré.
        }
    }

    // ------------------------------------------------------------------
    // Notification
    // ------------------------------------------------------------------
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Passerelle SMS", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Maintient l'envoi des SMS du studio.");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private void startForegroundCompat() {
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIF_ID, notification);
        }
    }

    private Notification buildNotification() {
        int pending = outbox.countPending();
        String text = connected
                ? (pending == 0 ? "En service" : pending + " SMS en attente d'envoi")
                : "Serveur injoignable…";

        Intent stopIntent = new Intent(this, SmsGatewayService.class).setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(
                this, 1, stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Passerelle SMS ERPLibre")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setOngoing(true)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Arrêter", stopPending)
                .build();
    }

    private void refreshNotification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(NOTIF_ID, buildNotification());
        }
    }

    // ------------------------------------------------------------------
    // Réception des accusés
    // ------------------------------------------------------------------
    private void registerResultReceiver() {
        resultReceiver = new SmsResultReceiver();
        IntentFilter filter = new IntentFilter();
        filter.addAction(SmsResultReceiver.ACTION_SENT);
        filter.addAction(SmsResultReceiver.ACTION_DELIVERED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(resultReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(resultReceiver, filter);
        }
    }

    // ------------------------------------------------------------------
    // Cadencement par alarme
    // ------------------------------------------------------------------
    private void registerCycleReceiver() {
        cycleReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                runCycleAsync();
            }
        };
        IntentFilter filter = new IntentFilter(ACTION_CYCLE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(cycleReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(cycleReceiver, filter);
        }
    }

    /**
     * Relance immédiatement dès que le réseau revient.
     *
     * <p>Sans cela, une coupure de quelques secondes coûterait un intervalle
     * entier d'attente — et le recul appliqué après un échec l'allongerait
     * encore.
     */
    private void registerNetworkCallback() {
        ConnectivityManager connectivity = getSystemService(ConnectivityManager.class);
        if (connectivity == null) {
            return;
        }
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                Log.i(TAG, "Réseau disponible, cycle immédiat");
                journal.info(SmsJournal.CAT_NETWORK, "Réseau revenu, cycle immédiat");
                consecutiveFailures = 0;
                triggerCycle();
            }
        };
        try {
            connectivity.registerDefaultNetworkCallback(networkCallback);
        } catch (Exception e) {
            Log.w(TAG, "Surveillance réseau indisponible : " + e.getMessage());
            networkCallback = null;
        }
    }

    private PendingIntent cyclePendingIntent() {
        Intent intent = new Intent(ACTION_CYCLE).setPackage(getPackageName());
        return PendingIntent.getBroadcast(this, ALARM_REQUEST_CODE, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Déclenche un cycle maintenant, sans attendre l'alarme. */
    private void triggerCycle() {
        cancelAlarm();
        runCycleAsync();
    }

    /**
     * Programme le prochain cycle.
     *
     * <p>{@code ELAPSED_REALTIME_WAKEUP} et non {@code RTC_WAKEUP} : l'horloge
     * murale peut sauter — synchronisation réseau, changement d'heure — alors
     * que le temps écoulé depuis le démarrage, lui, continue de compter pendant
     * la suspension.
     *
     * <p>Réarmée à la fin de chaque cycle plutôt que répétitive : une alarme
     * répétitive est inexacte, et surtout elle continuerait de tirer si un cycle
     * se bloquait.
     */
    private void scheduleNextCycle(long delayMs) {
        if (alarmManager == null || stopRequested.get()) {
            return;
        }
        long triggerAt = SystemClock.elapsedRealtime() + delayMs;
        PendingIntent pending = cyclePendingIntent();
        try {
            boolean exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                    || alarmManager.canScheduleExactAlarms();
            if (exact) {
                alarmManager.setExactAndAllowWhileIdle(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pending);
            } else {
                // Sans la permission d'alarme exacte, on reste fonctionnel :
                // hors Doze le déclenchement est ponctuel, et en Doze il est
                // simplement regroupé. C'est une dégradation, pas une panne.
                alarmManager.setAndAllowWhileIdle(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pending);
                Log.i(TAG, "Alarmes exactes non autorisées, cadencement approché");
                // Un état permanent, pas un événement : le journaliser à chaque
                // cycle produirait des milliers d'entrées identiques et noierait
                // ce qui change vraiment. Une seule ligne par vie du processus.
                if (!exactAlarmsReported) {
                    exactAlarmsReported = true;
                    journal.warn(SmsJournal.CAT_CYCLE,
                            "Alarmes exactes refusées : cadencement approché, les cycles peuvent glisser",
                            null);
                }
            }
        } catch (SecurityException e) {
            alarmManager.setAndAllowWhileIdle(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pending);
        }
    }

    private void cancelAlarm() {
        if (alarmManager != null) {
            alarmManager.cancel(cyclePendingIntent());
        }
    }

    /**
     * Exécute un cycle hors du thread principal, sous wakelock.
     *
     * <p>Le wakelock est acquis ici et relâché dans le {@code finally} du
     * travail : le wakelock que le système tient pendant {@code onReceive} est
     * relâché dès le retour de la méthode, bien avant la fin d'un appel réseau
     * suivi d'un envoi de SMS.
     */
    private void runCycleAsync() {
        if (worker == null || worker.isShutdown() || stopRequested.get()) {
            return;
        }
        final PowerManager.WakeLock lock = powerManager == null ? null
                : powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "erplibre:sms-cycle");
        if (lock != null) {
            lock.setReferenceCounted(false);
            lock.acquire(WAKELOCK_TIMEOUT_MS);
        }
        worker.execute(() -> {
            long nextDelayMs = RETRY_BACKOFF_MS[0];
            try {
                boolean ok = poll();
                if (ok) {
                    consecutiveFailures = 0;
                    nextDelayMs = jitter(Math.max(config.getPollSeconds(), 15) * 1000L);
                } else {
                    nextDelayMs = RETRY_BACKOFF_MS[
                            Math.min(consecutiveFailures, RETRY_BACKOFF_MS.length - 1)];
                    consecutiveFailures++;
                }
                expireOverdue();
                reporter.flush();
                drainOutbox();
            } catch (Exception e) {
                Log.e(TAG, "Cycle interrompu : " + e.getMessage());
                journal.error(SmsJournal.CAT_CYCLE, "Cycle interrompu : " + e.getMessage(), null);
                config.setLastError("Cycle : " + e.getMessage());
                nextDelayMs = RETRY_BACKOFF_MS[
                        Math.min(consecutiveFailures, RETRY_BACKOFF_MS.length - 1)];
                consecutiveFailures++;
            } finally {
                refreshNotification();
                scheduleNextCycle(nextDelayMs);
                if (lock != null && lock.isHeld()) {
                    lock.release();
                }
            }
        });
    }

    /** Dispersion de ±10 %, pour que plusieurs passerelles ne tirent pas ensemble. */
    private long jitter(long baseMs) {
        double factor = 0.9 + (System.nanoTime() % 200) / 1000.0;
        return (long) (baseMs * factor);
    }

    /**
     * Une interrogation : on envoie l'état, on reçoit les travaux.
     *
     * @return true si le serveur a répondu
     */
    private boolean poll() {
        try {
            JSONObject payload = reporter.envelope();
            payload.put("status", buildStatus());

            String response = reporter.exchange(OdooReporter.ENDPOINT_POLL, payload);
            if (response == null) {
                connected = false;
                lastSubscriptionError = config.getLastError();
                return false;
            }
            connected = true;
            lastSubscriptionError = "";
            lastPollAt = System.currentTimeMillis();
            if (response.isEmpty()) {
                return true;
            }

            JSONObject body = new JSONObject(response);
            config.setServerTuning(
                    body.optInt("segments_per_minute", 0),
                    body.optInt("poll_interval", 0));

            int inserted = enqueueResponse(body);
            if (inserted > 0) {
                Log.i(TAG, inserted + " SMS ajoutés à la file");
                journal.info(SmsJournal.CAT_CYCLE, inserted + " SMS reçus d'Odoo");
            }
            return true;
        } catch (Exception e) {
            connected = false;
            lastSubscriptionError = e.getClass().getSimpleName() + " : " + e.getMessage();
            config.setLastError(lastSubscriptionError);
            Log.w(TAG, "Interrogation échouée : " + e.getMessage());
            journal.warn(SmsJournal.CAT_NETWORK, "Interrogation d'Odoo échouée : " + e.getMessage(), null);
            return false;
        }
    }


    /**
     * L'application est-elle dispensee des optimisations de batterie ?
     *
     * <p>C'est LE facteur du cadencement. Sans dispense, Doze regroupe les
     * alarmes : mesure sur un Pixel 2 XL, un cycle regle a 30 s tient ~31 s en
     * regime normal, mais s'ouvre a plus de deux minutes des que l'appareil
     * s'assoupit. Sur un canal d'alerte, ces deux minutes sont exactement
     * celles qu'on ne peut pas se permettre.
     *
     * <p>Un appareil branche n'entre jamais en Doze — c'est la parade la plus
     * sure pour une passerelle dediee — mais on ne peut pas en faire
     * l'hypothese : un cable se debranche.
     */
    boolean ignoringBatteryOptimizations() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true;
        }
        try {
            return powerManager != null
                    && powerManager.isIgnoringBatteryOptimizations(getPackageName());
        } catch (Exception e) {
            return false;
        }
    }

    /** Les alarmes exactes sont-elles utilisables ? */
    boolean canScheduleExact() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return true;
        }
        try {
            return alarmManager != null && alarmManager.canScheduleExactAlarms();
        } catch (Exception e) {
            return false;
        }
    }

    /** État de la passerelle, envoyé à chaque interrogation. */
    private JSONObject buildStatus() throws Exception {
        JSONObject status = new JSONObject();
        status.put("sms_permission", hasSendPermission());
        status.put("sim_ready", resolveSmsManager() != null && simReady());
        status.put("outbox_pending", outbox.countPending());
        status.put("spooled_reports", outbox.countSpooled());
        status.put("battery", batteryPercent());
        status.put("charging", batteryCharging());
        status.put("app_version", appVersion());
        status.put("android_sdk", Build.VERSION.SDK_INT);
        status.put("doze_exempt", ignoringBatteryOptimizations());
        status.put("exact_alarms", canScheduleExact());
        status.put("device_model", Build.MANUFACTURER + " " + Build.MODEL);
        String error = config.getLastError();
        if (!error.isEmpty()) {
            status.put("last_error", error);
        }
        return status;
    }

    /**
     * Insère les travaux reçus dans la file persistante.
     *
     * <p>Le corps du message n'est écrit qu'une fois par groupe : c'est ce qui
     * garde une réponse compacte pour un envoi à quarante destinataires.
     */
    private int enqueueResponse(JSONObject body) throws Exception {
        long expiresAt = body.optLong("expires", 0L) * 1000L;
        JSONArray groups = body.optJSONArray("groups");
        if (groups == null) {
            return 0;
        }
        int inserted = 0;
        for (int g = 0; g < groups.length(); g++) {
            JSONObject group = groups.getJSONObject(g);
            String text = group.optString("body", "");
            JSONArray recipients = group.optJSONArray("to");
            if (recipients == null || text.isEmpty()) {
                continue;
            }
            for (int r = 0; r < recipients.length(); r++) {
                JSONObject recipient = recipients.getJSONObject(r);
                String uuid = recipient.optString("u", "");
                String number = recipient.optString("n", "");
                if (uuid.isEmpty() || number.isEmpty()) {
                    continue;
                }
                if (outbox.enqueue(uuid, body.optString("job", ""), number, text,
                        countSegments(text), expiresAt)) {
                    inserted++;
                }
            }
        }
        return inserted;
    }

    // ------------------------------------------------------------------
    // Envoi
    // ------------------------------------------------------------------
    /**
     * Vide la file autant que la limite de débit le permet, puis rend la main.
     *
     * <p>Ce n'est plus une boucle qui dort : ce qui reste part au cycle suivant.
     * Un groupe de quarante destinataires s'étale donc sur plusieurs cycles, ce
     * qui est exactement ce qu'impose de toute façon le plafond d'Android.
     */
    private void drainOutbox() {
        int sentThisCycle = 0;
        while (!stopRequested.get()) {
            List<SmsOutbox.Job> jobs = outbox.dueJobs(5);
            if (jobs.isEmpty()) {
                break;
            }
            boolean progressed = false;
            for (SmsOutbox.Job job : jobs) {
                if (stopRequested.get()) {
                    break;
                }
                int segments = Math.max(job.segments, 1);
                if (throttleDelay(segments, lastSendAt) > 0) {
                    // Le budget de la minute est épuisé : le reste attendra le
                    // prochain cycle plutôt que de dormir en tenant un wakelock.
                    return;
                }
                if (sendJob(job)) {
                    lastSendAt = System.currentTimeMillis();
                    outbox.logSegmentSent(segments);
                    sentThisCycle++;
                    progressed = true;
                }
                sleep(MIN_SEND_INTERVAL_MS);
            }
            if (!progressed) {
                break;
            }
        }
        if (sentThisCycle > 0) {
            Log.i(TAG, sentThisCycle + " SMS remis au réseau pendant ce cycle");
        }
    }

    /**
     * Retard à observer avant d'envoyer, en millisecondes, ou 0 si on peut y aller.
     *
     * <p>Android bloque à 30 segments par minute et par application — mesure
     * vérifiée dans {@code SmsUsageMonitor.java} de l'AOSP, où
     * {@code DEFAULT_SMS_MAX_COUNT} vaut 30 et {@code DEFAULT_SMS_CHECK_PERIOD}
     * vaut 60 000 ms. Au-delà, le système empile un dialogue de confirmation :
     * sur un téléphone posé dans un hall que personne ne regarde, cela veut dire
     * que rien ne part. On se tient donc volontairement sous la limite.
     */
    private long throttleDelay(int segments, long lastSendAt) {
        long sinceLast = System.currentTimeMillis() - lastSendAt;
        if (sinceLast < MIN_SEND_INTERVAL_MS) {
            return MIN_SEND_INTERVAL_MS - sinceLast;
        }
        int used = outbox.segmentsLastMinute();
        int budget = Math.max(config.getSegmentsPerMinute(), 1);
        if (used + segments > budget) {
            // Attendre que la fenêtre glissante se libère.
            return 5_000L;
        }
        return 0L;
    }

    private boolean sendJob(SmsOutbox.Job job) {
        if (!hasSendPermission()) {
            outbox.markState(job.smsUuid, SmsOutbox.STATE_FAILED, "GATEWAY_NO_PERMISSION", null);
            reportSimple(job.smsUuid, "failed", "GATEWAY_NO_PERMISSION",
                    "La permission d'envoi de SMS n'est pas accordée");
            outbox.remove(job.smsUuid);
            return false;
        }

        SmsManager manager = resolveSmsManager();
        if (manager == null) {
            outbox.markState(job.smsUuid, SmsOutbox.STATE_FAILED, "GATEWAY_SIM_ABSENT", null);
            return false;
        }

        try {
            outbox.markSending(job.smsUuid);
            ArrayList<String> parts = manager.divideMessage(job.body);
            ArrayList<PendingIntent> sentIntents = new ArrayList<>();
            ArrayList<PendingIntent> deliveryIntents = new ArrayList<>();

            for (int index = 0; index < parts.size(); index++) {
                int requestCode = config.nextRequestCode();
                outbox.recordSegment(requestCode, job.smsUuid, index);
                sentIntents.add(resultIntent(
                        SmsResultReceiver.ACTION_SENT, job.smsUuid, index, requestCode));
                int deliveryCode = config.nextRequestCode();
                outbox.recordSegment(deliveryCode, job.smsUuid, index);
                deliveryIntents.add(resultIntent(
                        SmsResultReceiver.ACTION_DELIVERED, job.smsUuid, index, deliveryCode));
            }

            manager.sendMultipartTextMessage(
                    job.number, null, parts, sentIntents, deliveryIntents);
            Log.i(TAG, "Envoyé à " + job.number + " en " + parts.size() + " segment(s)");
            journal.withDetail(SmsJournal.LEVEL_INFO, SmsJournal.CAT_SEND,
                    "Remis au réseau en " + parts.size() + " segment(s)", job.smsUuid,
                    job.number + " : " + job.body);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Envoi impossible vers " + job.number + " : " + e.getMessage());
            journal.error(SmsJournal.CAT_SEND, "Envoi impossible : " + e.getMessage(), job.smsUuid);
            outbox.markState(job.smsUuid, SmsOutbox.STATE_FAILED,
                    "GATEWAY_SEND_EXCEPTION", e.getMessage());
            if (outbox.attemptsOf(job.smsUuid) >= SmsOutbox.MAX_ATTEMPTS) {
                reportSimple(job.smsUuid, "failed", "GATEWAY_ABANDONED", e.getMessage());
                outbox.remove(job.smsUuid);
            }
            return false;
        }
    }

    /**
     * Construit un PendingIntent d'accusé.
     *
     * <p>Action FIXE — sans quoi aucun IntentFilter ne pourrait l'apparier — et
     * code de requête UNIQUE, issu d'un compteur persisté, pour que chaque
     * segment ait son propre PendingIntent malgré l'action commune.
     */
    private PendingIntent resultIntent(String action, String smsUuid, int index, int requestCode) {
        Intent intent = new Intent(action)
                .setPackage(getPackageName())
                .putExtra(SmsResultReceiver.EXTRA_UUID, smsUuid)
                .putExtra(SmsResultReceiver.EXTRA_SEGMENT, index)
                .putExtra(SmsResultReceiver.EXTRA_REQUEST_CODE, requestCode);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Mutable est nécessaire pour que le système y place le code de
            // résultat ; l'intent est explicite par setPackage(), ce qui satisfait
            // la restriction d'Android 14 sur les PendingIntent mutables.
            flags |= PendingIntent.FLAG_MUTABLE;
        }
        return PendingIntent.getBroadcast(this, requestCode, intent, flags);
    }

    private void expireOverdue() {
        for (SmsOutbox.Job job : outbox.expiredJobs()) {
            Log.w(TAG, "Travail expiré sans envoi : " + job.smsUuid);
            journal.warn(SmsJournal.CAT_SEND, "Expiré sans avoir été envoyé", job.smsUuid);
            reportSimple(job.smsUuid, "failed", "GATEWAY_DEADLINE",
                    "Échéance dépassée avant envoi");
            outbox.remove(job.smsUuid);
        }
    }

    private void reportSimple(String smsUuid, String state, String code, String reason) {
        try {
            JSONObject event = new JSONObject();
            event.put("uuid", smsUuid);
            event.put("seq", outbox.nextSeq(smsUuid));
            event.put("state", state);
            event.put("at", System.currentTimeMillis() / 1000L);
            if (code != null) {
                event.put("code", code);
            }
            if (reason != null) {
                event.put("reason", reason);
            }
            JSONArray events = new JSONArray().put(event);
            JSONObject payload = reporter.envelope();
            payload.put("events", events);
            reporter.submit(OdooReporter.ENDPOINT_REPORT, payload);
        } catch (Exception e) {
            Log.e(TAG, "Rapport impossible : " + e.getMessage());
        }
    }

    // ------------------------------------------------------------------
    // Utilitaires
    // ------------------------------------------------------------------
    boolean hasSendPermission() {
        return checkSelfPermission(android.Manifest.permission.SEND_SMS)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean simReady() {
        TelephonyManager telephony = getSystemService(TelephonyManager.class);
        return telephony != null && telephony.getSimState() == TelephonyManager.SIM_STATE_READY;
    }

    private SmsManager resolveSmsManager() {
        try {
            int subId = config.getSubscriptionId();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // getDefault() est déprécié depuis Android 12.
                SmsManager manager = getSystemService(SmsManager.class);
                if (manager == null) {
                    return null;
                }
                return subId >= 0 ? manager.createForSubscriptionId(subId) : manager;
            }
            return subId >= 0
                    ? SmsManager.getSmsManagerForSubscriptionId(subId)
                    : SmsManager.getDefault();
        } catch (Exception e) {
            Log.e(TAG, "SmsManager indisponible : " + e.getMessage());
            journal.error(SmsJournal.CAT_SEND, "SmsManager indisponible : " + e.getMessage(), null);
            return null;
        }
    }

    /** Nombre de segments d'un corps, tel que le calculerait SmsManager. */
    private int countSegments(String body) {
        try {
            SmsManager manager = resolveSmsManager();
            if (manager != null) {
                return Math.max(manager.divideMessage(body).size(), 1);
            }
        } catch (Exception ignored) {
            // Repli sur une estimation.
        }
        return Math.max((int) Math.ceil(body.length() / 70.0), 1);
    }

    private int batteryPercent() {
        BatteryManager battery = getSystemService(BatteryManager.class);
        return battery == null ? 0 : battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
    }

    private boolean batteryCharging() {
        BatteryManager battery = getSystemService(BatteryManager.class);
        return battery != null && battery.isCharging();
    }

    private String appVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "?";
        }
    }


    private void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
