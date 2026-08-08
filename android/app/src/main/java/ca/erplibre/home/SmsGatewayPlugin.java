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
        if (!isAcceptableUrl(odooBaseUrl)) {
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
    static boolean isAcceptableUrl(String url) {
        if (url == null) {
            return false;
        }
        String value = url.trim().toLowerCase();
        if (value.startsWith("https://")) {
            return true;
        }
        return value.startsWith("http://10.0.2.2")
                || value.startsWith("http://127.0.0.1")
                || value.startsWith("http://localhost");
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
