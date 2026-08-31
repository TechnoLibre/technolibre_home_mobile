package ca.erplibre.home;

import android.content.Context;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.List;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Achemine les rapports vers Odoo, en signant chaque corps en HMAC-SHA256.
 *
 * <p>Tout rapport est d'abord écrit dans la file persistante, puis expédié. Un
 * téléphone hors réseau ne perd donc rien : il rattrape au retour de la
 * connexion. C'est indispensable, parce qu'un accusé perdu ferait conclure Odoo
 * à un échec pour un SMS réellement parti, puis republier — donc envoyer le
 * message deux fois.
 */
public class OdooReporter {

    private static final String TAG = "OdooReporter";
    private static final String SIGNATURE_HEADER = "X-Erplibre-Signature";
    private static final String SIGNATURE_PREFIX = "sha256=";
    private static final int TIMEOUT_MS = 20_000;

    public static final String ENDPOINT_POLL = "/erplibre_sms/poll";
    public static final String ENDPOINT_REPORT = "/erplibre_sms/report";
    public static final String ENDPOINT_INBOUND = "/erplibre_sms/inbound";

    private final Context context;
    private final SmsGatewayConfig config;
    private final SmsOutbox outbox;
    private final SecureRandom random = new SecureRandom();

    public OdooReporter(Context context) {
        this.context = context.getApplicationContext();
        this.config = new SmsGatewayConfig(this.context);
        this.outbox = SmsOutbox.get(this.context);
    }

    /** Complète l'enveloppe commune : version, appareil, horodatage, nonce. */
    public JSONObject envelope() throws JSONException {
        byte[] bytes = new byte[16];
        random.nextBytes(bytes);
        JSONObject payload = new JSONObject();
        payload.put("v", 1);
        payload.put("device", config.getDeviceId());
        payload.put("ts", System.currentTimeMillis() / 1000L);
        payload.put("nonce", toHex(bytes));
        return payload;
    }

    /**
     * Met en file puis tente l'expédition immédiate, hors thread principal.
     *
     * <p>Les deux appelants sont des BroadcastReceiver : {@code onReceive}
     * s'exécute sur le thread principal, où Android interdit tout accès réseau
     * — d'où le NetworkOnMainThreadException observé sur appareil réel.
     *
     * <p>La mise en file, elle, reste synchrone : c'est une écriture SQLite
     * locale, rapide et autorisée. C'est aussi ce qui rend l'expédition
     * différée sans risque — si le processus meurt avant l'envoi, le cycle
     * suivant du service reprend la file. On n'a donc pas besoin de goAsync()
     * pour garantir la remise : la durabilité vient de la file, pas du thread.
     */
    public void submit(String endpoint, JSONObject payload) {
        outbox.spool(endpoint, payload.toString());
        NETWORK.execute(this::flush);
    }

    /**
     * Un seul thread : les envois restent sérialisés, comme le veut flush()
     * qui est synchronized. Deux accusés reçus coup sur coup ne se marchent
     * pas dessus, ils se suivent.
     */
    private static final java.util.concurrent.ExecutorService NETWORK =
            java.util.concurrent.Executors.newSingleThreadExecutor(r -> {
                Thread t = new Thread(r, "erplibre-sms-report");
                t.setDaemon(true);
                return t;
            });


    /**
     * Journalise les CHANGEMENTS de joignabilité, pas chaque échec.
     *
     * <p>Une panne de serveur se répète à chaque cycle : à vingt secondes
     * d'intervalle, tout consigner produirait plus de quatre mille entrées par
     * jour et noierait le reste. Ce qu'un exploitant a besoin de lire, c'est
     * « injoignable depuis 14 h 03 » puis « revenu à 14 h 52 » — deux lignes.
     *
     * <p>L'état précédent est déduit de {@code lastError} plutôt que d'un champ
     * en mémoire : le service peut être tué et relancé entre deux cycles, et une
     * variable d'instance rejournaliserait la même panne à chaque redémarrage.
     */
    private void noteReachable(boolean reachable, String reason) {
        boolean wasFailing = !config.getLastError().isEmpty();
        if (reachable == !wasFailing) {
            return;
        }
        SmsJournal journal = new SmsJournal(context);
        if (reachable) {
            journal.info(SmsJournal.CAT_NETWORK, "Odoo de nouveau joignable");
        } else {
            journal.warn(SmsJournal.CAT_NETWORK, "Odoo injoignable : " + reason, null);
        }
    }

    /** Vide la file des rapports en attente. */
    public synchronized void flush() {
        if (!config.isConfigured()) {
            return;
        }
        List<SmsOutbox.SpoolEntry> entries = outbox.spooled(20);
        for (SmsOutbox.SpoolEntry entry : entries) {
            boolean ok = post(entry.endpoint, entry.payload);
            if (ok) {
                outbox.spoolDone(entry.id);
            } else {
                outbox.spoolFailed(entry.id);
                // Inutile d'insister sur les suivants : le réseau est en cause.
                break;
            }
        }
    }

    /**
     * POST signé dont on exploite la réponse — le cas de l'interrogation.
     *
     * <p>Contrairement à {@link #submit}, cet appel n'est pas mis en file : une
     * interrogation manquée n'a pas à être rejouée, la suivante arrive dans une
     * minute. La rejouer ne ferait que dupliquer un travail que le serveur
     * repropose déjà de lui-même.
     *
     * @return le corps de la réponse, ou {@code null} si l'appel a échoué
     */
    public String exchange(String endpoint, JSONObject payload) {
        return postForBody(endpoint, payload.toString());
    }

    /**
     * Expédie un corps déjà sérialisé.
     *
     * <p>La signature porte sur les octets EXACTEMENT tels qu'ils sont transmis :
     * re-sérialiser le JSON côté serveur donnerait une empreinte différente.
     */
    private boolean post(String endpoint, String body) {
        return postForBody(endpoint, body) != null;
    }

    /** Exécute le POST signé et renvoie le corps de la réponse, ou null. */
    private String postForBody(String endpoint, String body) {
        HttpURLConnection connection = null;
        try {
            byte[] raw = body.getBytes(StandardCharsets.UTF_8);
            URL url = new URL(trimSlash(config.getOdooBaseUrl()) + endpoint);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(TIMEOUT_MS);
            connection.setReadTimeout(TIMEOUT_MS);
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(raw.length);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty(SIGNATURE_HEADER, SIGNATURE_PREFIX + sign(raw));

            try (OutputStream stream = connection.getOutputStream()) {
                stream.write(raw);
            }

            int status = connection.getResponseCode();
            if (status >= 200 && status < 300) {
                noteReachable(true, null);
                config.setLastError("");
                return readBody(connection.getInputStream());
            }
            // 409 = nonce rejoué : le serveur a déjà traité cette requête, la
            // renvoyer ne servirait à rien. On la considère comme acheminée.
            if (status == 409) {
                Log.i(TAG, "Requête déjà reçue par le serveur (nonce rejoué)");
                return "";
            }
            noteReachable(false, "HTTP " + status + " sur " + endpoint);
            config.setLastError("HTTP " + status + " sur " + endpoint);
            Log.w(TAG, "Requête refusée : HTTP " + status + " sur " + endpoint);
            return null;
        } catch (Exception e) {
            noteReachable(false, e.getClass().getSimpleName() + " : " + e.getMessage());
            config.setLastError(e.getClass().getSimpleName() + " : " + e.getMessage());
            Log.w(TAG, "Requête non acheminée : " + e.getMessage());
            return null;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static String readBody(java.io.InputStream stream) throws Exception {
        try (java.io.BufferedReader reader = new java.io.BufferedReader(
                new java.io.InputStreamReader(stream, StandardCharsets.UTF_8))) {
            StringBuilder builder = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                builder.append(line);
            }
            return builder.toString();
        }
    }

    private String sign(byte[] raw) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(
                config.getHmacSecret().getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return toHex(mac.doFinal(raw));
    }

    private static String toHex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            builder.append(Character.forDigit((b >> 4) & 0xF, 16));
            builder.append(Character.forDigit(b & 0xF, 16));
        }
        return builder.toString();
    }

    private static String trimSlash(String value) {
        return value.endsWith("/") ? value.substring(0, value.length() - 1) : value;
    }
}
