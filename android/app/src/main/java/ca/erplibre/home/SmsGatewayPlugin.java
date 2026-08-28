package ca.erplibre.home;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.provider.Telephony;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.List;

/**
 * Pont entre l'interface de l'application et la passerelle SMS.
 *
 * <p>Le plugin ne fait qu'orchestrer : la logique d'envoi vit dans
 * {@link SmsGatewayService}, parce qu'elle doit survivre a la mort de la WebView.
 * Un abonnement maintenu depuis un {@code EventSource} de WebView ne tient pas la
 * veille d'Android.
 */
@CapacitorPlugin(
        name = "SmsGateway",
        permissions = {
                @Permission(alias = "send", strings = {Manifest.permission.SEND_SMS}),
                @Permission(alias = "receive", strings = {Manifest.permission.RECEIVE_SMS}),
        }
)
public class SmsGatewayPlugin extends Plugin {

    /** Limite d'Android, verifiee dans SmsUsageMonitor.java de l'AOSP. */
    private static final int ANDROID_SEGMENT_LIMIT_PER_MINUTE = 30;

    private SmsGatewayConfig config;
    private SmsOutbox outbox;

    @Override
    public void load() {
        config = new SmsGatewayConfig(getContext());
        outbox = SmsOutbox.get(getContext());
    }

    // ------------------------------------------------------------------
    @PluginMethod
    public void getCapabilities(PluginCall call) {
        JSObject result = new JSObject();
        result.put("hasSendPermission", granted(Manifest.permission.SEND_SMS));
        result.put("hasReceivePermission", granted(Manifest.permission.RECEIVE_SMS));
        result.put("androidSdk", Build.VERSION.SDK_INT);
        result.put("deviceModel", Build.MANUFACTURER + " " + Build.MODEL);
        result.put("segmentLimitPerMinute", ANDROID_SEGMENT_LIMIT_PER_MINUTE);
        result.put("isDefaultSmsApp", isDefaultSmsApp());
        result.put("dozeExempt", ignoringBatteryOptimizations());
        result.put("canScheduleExactAlarms", canScheduleExact());
        result.put("allowPlainLan", config.allowPlainLan());

        TelephonyManager telephony = getContext().getSystemService(TelephonyManager.class);
        result.put("simReady", telephony != null
                && telephony.getSimState() == TelephonyManager.SIM_STATE_READY);

        JSArray sims = new JSArray();
        try {
            SubscriptionManager subscriptions =
                    getContext().getSystemService(SubscriptionManager.class);
            if (subscriptions != null && granted(Manifest.permission.READ_PHONE_STATE)) {
                List<SubscriptionInfo> list = subscriptions.getActiveSubscriptionInfoList();
                if (list != null) {
                    for (SubscriptionInfo info : list) {
                        JSObject sim = new JSObject();
                        sim.put("subscriptionId", info.getSubscriptionId());
                        sim.put("carrier", String.valueOf(info.getCarrierName()));
                        sim.put("slot", info.getSimSlotIndex());
                        sims.put(sim);
                    }
                }
            }
        } catch (SecurityException ignored) {
            // Sans READ_PHONE_STATE, la liste des SIM reste vide : ce n'est pas
            // bloquant, la SIM par defaut sera utilisee.
        }
        result.put("sims", sims);
        call.resolve(result);
    }

    @PluginMethod
    public void requestSmsPermissions(PluginCall call) {
        requestPermissionForAliases(new String[]{"send", "receive"}, call, "permissionsCallback");
    }

    @PermissionCallback
    private void permissionsCallback(PluginCall call) {
        JSObject result = new JSObject();
        result.put("hasSendPermission", granted(Manifest.permission.SEND_SMS));
        result.put("hasReceivePermission", granted(Manifest.permission.RECEIVE_SMS));
        call.resolve(result);
    }

    // ------------------------------------------------------------------
    @PluginMethod
    public void configure(PluginCall call) {
        String odooBaseUrl = call.getString("odooBaseUrl");
        String hmacSecret = call.getString("hmacSecret");
        String deviceId = call.getString("deviceId");

        if (odooBaseUrl == null || hmacSecret == null || deviceId == null) {
            call.reject("Parametres requis : odooBaseUrl, hmacSecret, deviceId");
            return;
        }
        Boolean lanDemande = call.getBoolean("allowPlainLan");
        boolean lan = lanDemande != null ? lanDemande : config.allowPlainLan();
        if (!isAcceptableUrl(odooBaseUrl, lan)) {
            call.reject("L'URL du serveur doit etre en HTTPS : le contenu des messages et "
                    + "les numeros de telephone y transitent. Seules les adresses de "
                    + "bouclage et l'hote d'un emulateur sont tolerees en HTTP, pour le "
                    + "developpement.");
            return;
        }

        config.configure(
                odooBaseUrl,
                hmacSecret,
                deviceId,
                call.getInt("subscriptionId", -1)
        );
        if (lanDemande != null) {
            config.setAllowPlainLan(lanDemande);
        }
        Boolean keepBodies = call.getBoolean("journalKeepsBodies");
        if (keepBodies != null) {
            config.setJournalKeepsBodies(keepBodies);
        }
        call.resolve();
    }

    /**
     * Les entrées du journal, plus récentes d'abord.
     *
     * <p>{@code category} filtre facultativement ; {@code limit} borne le
     * volume renvoyé au pont, qui sérialise en JSON — inutile d'en passer
     * dix mille à une liste qui en affiche cinquante.
     */
    @PluginMethod
    public void journalEntries(PluginCall call) {
        SmsJournal journal = new SmsJournal(getContext());
        List<SmsJournal.Entry> entries =
                journal.entries(call.getString("category"), call.getInt("limit", 200));

        JSArray array = new JSArray();
        for (SmsJournal.Entry entry : entries) {
            JSObject item = new JSObject();
            item.put("id", entry.id);
            item.put("at", entry.at);
            item.put("level", entry.level);
            item.put("category", entry.category);
            item.put("message", entry.message);
            item.put("smsUuid", entry.smsUuid);
            item.put("detail", entry.detail);
            array.put(item);
        }

        JSObject result = new JSObject();
        result.put("entries", array);
        result.put("count", journal.size());
        result.put("usedBytes", journal.usedBytes());
        result.put("keepsBodies", config.journalKeepsBodies());
        call.resolve(result);
    }


    // ------------------------------------------------------------------
    // Cadencement : ce qui decide si un cycle part a l'heure
    // ------------------------------------------------------------------

    private boolean ignoringBatteryOptimizations() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true;
        }
        try {
            android.os.PowerManager pm =
                    getContext().getSystemService(android.os.PowerManager.class);
            return pm != null
                    && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        } catch (Exception e) {
            return false;
        }
    }

    private boolean canScheduleExact() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return true;
        }
        try {
            android.app.AlarmManager am =
                    getContext().getSystemService(android.app.AlarmManager.class);
            return am != null && am.canScheduleExactAlarms();
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Ouvre le reglage systeme de dispense des optimisations de batterie.
     *
     * <p>On NE demande PAS la dispense par une boite de dialogue directe
     * (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) : Google la reserve a des
     * cas precis et la refuse a la publication. On ouvre la liste, ou
     * l'utilisateur choisit lui-meme — c'est plus long, mais c'est le chemin
     * que le systeme accepte durablement.
     */
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        JSObject result = new JSObject();
        if (ignoringBatteryOptimizations()) {
            result.put("alreadyExempt", true);
            call.resolve(result);
            return;
        }
        try {
            android.content.Intent intent = new android.content.Intent(
                    android.provider.Settings
                            .ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            result.put("alreadyExempt", false);
            result.put("opened", true);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Reglage introuvable : " + e.getMessage());
        }
    }

    /**
     * Ouvre le reglage des alarmes exactes (Android 12+).
     *
     * <p>Sans elles, `setExactAndAllowWhileIdle` devient `setAndAllowWhileIdle`
     * et les cycles se regroupent. Sur Android 11 et anterieurs la permission
     * n'existe pas : la methode se contente de le dire.
     */
    @PluginMethod
    public void requestExactAlarms(PluginCall call) {
        JSObject result = new JSObject();
        if (canScheduleExact()) {
            result.put("alreadyGranted", true);
            call.resolve(result);
            return;
        }
        try {
            android.content.Intent intent = new android.content.Intent(
                    android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            result.put("alreadyGranted", false);
            result.put("opened", true);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Reglage introuvable : " + e.getMessage());
        }
    }

    /** Efface le journal. Ne touche ni à la file d'envoi ni aux rapports. */
    @PluginMethod
    public void clearJournal(PluginCall call) {
        JSObject result = new JSObject();
        result.put("deleted", new SmsJournal(getContext()).clear());
        call.resolve(result);
    }

    @PluginMethod
    public void startGateway(PluginCall call) {
        if (!config.isConfigured()) {
            call.reject("La passerelle n'est pas configuree.");
            return;
        }
        if (!granted(Manifest.permission.SEND_SMS)) {
            call.reject("La permission d'envoi de SMS n'est pas accordee.");
            return;
        }
        config.setEnabled(true);
        SmsGatewayService.start(getContext());
        call.resolve();
    }

    @PluginMethod
    public void stopGateway(PluginCall call) {
        config.setEnabled(false);
        SmsGatewayService.stop(getContext());
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", config.isEnabled());
        result.put("configured", config.isConfigured());
        result.put("running", SmsGatewayService.running);
        result.put("connected", SmsGatewayService.connected);
        result.put("lastPollAt", SmsGatewayService.lastPollAt);
        result.put("pending", outbox.countPending());
        result.put("spooledReports", outbox.countSpooled());
        result.put("segmentsLastMinute", outbox.segmentsLastMinute());
        result.put("segmentsPerMinute", config.getSegmentsPerMinute());
        result.put("pollSeconds", config.getPollSeconds());
        result.put("hasSendPermission", granted(Manifest.permission.SEND_SMS));
        result.put("lastError", config.getLastError());
        result.put("connectionError", SmsGatewayService.lastSubscriptionError);
        call.resolve(result);
    }

    /**
     * Force un tour de boucle. Utile apres une reconfiguration, pour ne pas
     * attendre le prochain reveil du service.
     */
    @PluginMethod
    public void kick(PluginCall call) {
        SmsGatewayService.kick(getContext());
        call.resolve();
    }

    @PluginMethod
    public void clearLastError(PluginCall call) {
        config.setLastError("");
        call.resolve();
    }

    /**
     * Le HTTPS est exige, sauf pour des adresses NON ROUTABLES.
     *
     * <p>La derogation existe pour pouvoir tester contre un Odoo local : depuis
     * un emulateur Android, la machine hote est joignable a 10.0.2.2. Ces
     * adresses ne quittent jamais la machine, donc la derogation ne peut pas
     * servir a exposer des numeros de telephone sur un reseau.
     */
    /** Adresses IPv4 des plages privees RFC 1918, plus le bouclage. */
    private static final java.util.regex.Pattern LAN_PRIVEE =
            java.util.regex.Pattern.compile(
                    "^http://("
                            + "10\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})"
                            + "|172\\.(1[6-9]|2\\d|3[01])\\.(\\d{1,3})\\.(\\d{1,3})"
                            + "|192\\.168\\.(\\d{1,3})\\.(\\d{1,3})"
                            + ")(:\\d+)?(/.*)?$");

    static boolean isAcceptableUrl(String url) {
        return isAcceptableUrl(url, false);
    }

    /**
     * L'URL est-elle acceptable pour y faire transiter des SMS ?
     *
     * <p>HTTPS toujours. En clair, seules les adresses NON ROUTABLES —
     * bouclage et l'hote vu d'un emulateur — sont tolerees sans condition :
     * elles ne quittent jamais l'appareil.
     *
     * <p>Le reseau local en clair demande un accord EXPLICITE
     * ({@code allowPlainLan}), parce que les numeros et le corps des messages
     * y circulent lisibles par quiconque partage le Wi-Fi. Meme alors, on
     * s'en tient aux plages privees : une adresse publique en HTTP reste
     * refusee, quel que soit le reglage.
     */
    static boolean isAcceptableUrl(String url, boolean allowPlainLan) {
        if (url == null) {
            return false;
        }
        String value = url.trim().toLowerCase();
        if (value.startsWith("https://")) {
            return true;
        }
        if (value.startsWith("http://10.0.2.2")
                || value.startsWith("http://127.0.0.1")
                || value.startsWith("http://localhost")) {
            return true;
        }
        return allowPlainLan && LAN_PRIVEE.matcher(value).matches();
    }

    // ------------------------------------------------------------------
    private boolean granted(String permission) {
        return getContext().checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * L'application est-elle celle qui gere les SMS du telephone ?
     *
     * <p>On ne le devient PAS volontairement : ce role exempterait de la limite
     * de debit d'Android, mais imposerait de recevoir et de stocker tous les SMS
     * du telephone, dont les codes d'authentification bancaires. Ce n'est pas
     * defendable pour un appareil partage laisse dans un lieu passant.
     */
    private boolean isDefaultSmsApp() {
        String current = Telephony.Sms.getDefaultSmsPackage(getContext());
        return current != null && current.equals(getContext().getPackageName());
    }
}
