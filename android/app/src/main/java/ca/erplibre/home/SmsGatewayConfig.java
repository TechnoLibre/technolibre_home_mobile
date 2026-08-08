package ca.erplibre.home;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Configuration de la passerelle, et compteurs qui doivent survivre au processus.
 *
 * <p>Le compteur {@code requestCode} est ici et non en mémoire : c'est lui qui
 * rend chaque {@link android.app.PendingIntent} d'accusé de réception distinct.
 * Repartir de 1 après un redémarrage ferait collisionner les nouveaux
 * PendingIntent avec les anciens — {@code filterEquals} étant vrai puisque
 * l'action est fixe — et les statuts se mélangeraient entre destinataires.
 */
public class SmsGatewayConfig {

    private static final String PREFS = "erplibre_sms_gateway";

    private static final String KEY_ENABLED = "enabled";
    private static final String KEY_ODOO_BASE = "odoo_base_url";
    private static final String KEY_HMAC_SECRET = "hmac_secret";
    private static final String KEY_DEVICE_ID = "device_id";
    private static final String KEY_SUB_ID = "subscription_id";
    private static final String KEY_REQUEST_CODE = "request_code";
    private static final String KEY_SEGMENTS_PER_MINUTE = "segments_per_minute";
    private static final String KEY_POLL_SECONDS = "poll_seconds";
    private static final String KEY_LAST_ERROR = "last_error";
    private static final String KEY_JOURNAL_BODIES = "journal_bodies";

    private final SharedPreferences prefs;

    public SmsGatewayConfig(Context context) {
        this.prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public boolean isEnabled() {
        return prefs.getBoolean(KEY_ENABLED, false);
    }

    /**
     * Le journal retient-il le corps des messages et les numéros complets ?
     *
     * <p>Faux par défaut, et le défaut compte : activer ceci écrit des données
     * de membres — noms, numéros, contenu — sur un téléphone qui peut être perdu
     * ou volé. Le diagnostic devient plus facile, mais ce n'est pas à l'outil de
     * prendre ce risque tout seul. Les métadonnées et les états, eux, sont
     * toujours journalisés : ils suffisent à la quasi-totalité des pannes.
     */
    public boolean journalKeepsBodies() {
        return prefs.getBoolean(KEY_JOURNAL_BODIES, false);
    }

    public void setJournalKeepsBodies(boolean keep) {
        prefs.edit().putBoolean(KEY_JOURNAL_BODIES, keep).apply();
    }

    public void setEnabled(boolean enabled) {
        prefs.edit().putBoolean(KEY_ENABLED, enabled).apply();
    }

    public String getOdooBaseUrl() {
        return prefs.getString(KEY_ODOO_BASE, "");
    }

    public String getHmacSecret() {
        return prefs.getString(KEY_HMAC_SECRET, "");
    }

    public String getDeviceId() {
        return prefs.getString(KEY_DEVICE_ID, "");
    }

    public int getSubscriptionId() {
        return prefs.getInt(KEY_SUB_ID, -1);
    }

    public int getSegmentsPerMinute() {
        return prefs.getInt(KEY_SEGMENTS_PER_MINUTE, 24);
    }

    /** Rythme d'interrogation du serveur, en secondes. Pilote par le serveur. */
    public int getPollSeconds() {
        return prefs.getInt(KEY_POLL_SECONDS, 60);
    }

    public void configure(String odooBaseUrl, String hmacSecret, String deviceId,
                          int subscriptionId) {
        SharedPreferences.Editor editor = prefs.edit();
        if (odooBaseUrl != null) editor.putString(KEY_ODOO_BASE, odooBaseUrl);
        if (hmacSecret != null) editor.putString(KEY_HMAC_SECRET, hmacSecret);
        if (deviceId != null) editor.putString(KEY_DEVICE_ID, deviceId);
        editor.putInt(KEY_SUB_ID, subscriptionId);
        editor.apply();
    }

    /** Le serveur pilote le rythme : on peut le ralentir sans toucher au telephone. */
    public void setServerTuning(int segmentsPerMinute, int pollSeconds) {
        SharedPreferences.Editor editor = prefs.edit();
        if (segmentsPerMinute > 0) {
            editor.putInt(KEY_SEGMENTS_PER_MINUTE, segmentsPerMinute);
        }
        if (pollSeconds > 0) {
            editor.putInt(KEY_POLL_SECONDS, pollSeconds);
        }
        editor.apply();
    }

    public boolean isConfigured() {
        return !getOdooBaseUrl().isEmpty()
                && !getHmacSecret().isEmpty()
                && !getDeviceId().isEmpty();
    }

    // -- Codes de requête ------------------------------------------------
    public synchronized int nextRequestCode() {
        int next = prefs.getInt(KEY_REQUEST_CODE, 1) + 1;
        if (next >= Integer.MAX_VALUE - 1000) {
            next = 1;
        }
        prefs.edit().putInt(KEY_REQUEST_CODE, next).apply();
        return next;
    }

    // -- Diagnostic ------------------------------------------------------
    public String getLastError() {
        return prefs.getString(KEY_LAST_ERROR, "");
    }

    public void setLastError(String message) {
        prefs.edit().putString(KEY_LAST_ERROR, message == null ? "" : message).apply();
    }
}
