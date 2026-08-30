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
    private static final String KEY_ALLOW_PLAIN_LAN = "allow_plain_lan";
    private static final String KEY_CALL_LOG_DURATION = "call_log_duration";
    private static final String KEY_SERVICE_LIVE = "service_live";

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
    /**
     * Le HTTP en clair est-il tolere vers le reseau local ?
     *
     * <p>Faux par defaut, et le defaut compte : sur un reseau en clair, les
     * numeros et le corps des messages passent en clair. Quiconque partage le
     * Wi-Fi les lit. Ce n'est acceptable que sur un reseau qu'on maitrise, pour
     * une demonstration ou un developpement — jamais pour un studio dont le
     * Wi-Fi est ouvert aux eleves.
     *
     * <p>Meme active, l'interrupteur ne tolere QUE les plages privees. Une
     * adresse publique en HTTP reste refusee : il n'existe aucune raison
     * legitime d'envoyer des donnees de membres en clair sur Internet.
     */
    public boolean allowPlainLan() {
        return prefs.getBoolean(KEY_ALLOW_PLAIN_LAN, false);
    }

    public void setAllowPlainLan(boolean allow) {
        prefs.edit().putBoolean(KEY_ALLOW_PLAIN_LAN, allow).apply();
    }

    /**
     * Lire la duree exacte dans le journal d'appels d'Android ?
     *
     * <p>Faux par defaut. La mesure interne suffit a savoir si quelqu'un a
     * parle deux minutes ou dix secondes ; elle inclut simplement la sonnerie.
     * Le journal d'Android donne le chiffre de l'operateur, mais le lire exige
     * READ_CALL_LOG, qui ouvre TOUT l'historique d'appels de l'appareil.
     *
     * <p>Anodin sur un telephone dedie a la passerelle. Sur le telephone
     * personnel de quelqu'un, c'est une intrusion — et ce n'est pas a l'outil
     * de la decider.
     */
    public boolean callLogDuration() {
        return prefs.getBoolean(KEY_CALL_LOG_DURATION, false);
    }

    public void setCallLogDuration(boolean actif) {
        prefs.edit().putBoolean(KEY_CALL_LOG_DURATION, actif).apply();
    }

    /**
     * Le service etait-il vivant la derniere fois qu'on a regarde ?
     *
     * <p>Persiste a dessein : un drapeau en memoire meurt avec le processus,
     * donc il vaut toujours « non » au redemarrage — precisement dans le cas
     * qu'on cherche a reconnaitre. Ecrit ici, il permet a un processus neuf de
     * constater que le precedent est mort sans prevenir.
     */
    public boolean serviceLive() {
        return prefs.getBoolean(KEY_SERVICE_LIVE, false);
    }

    public void setServiceLive(boolean vivant) {
        // `commit` et non `apply` : quand Android tue le processus, une
        // ecriture differee n'a pas le temps de partir, et le drapeau mentirait
        // au demarrage suivant.
        prefs.edit().putBoolean(KEY_SERVICE_LIVE, vivant).commit();
    }

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
