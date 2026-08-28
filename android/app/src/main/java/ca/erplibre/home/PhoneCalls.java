package ca.erplibre.home;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.CallLog;
import android.telephony.PhoneStateListener;
import android.telephony.TelephonyManager;
import android.util.Log;

import java.util.UUID;

/**
 * Placer des appels, et mesurer leur duree.
 *
 * <h2>Ce qu'Android permet, et ce qu'il ne permet pas</h2>
 *
 * <p>Une application peut composer un numero. Elle ne peut PAS injecter de son
 * dans la conversation : le chemin audio d'un appel est reserve au telephone.
 * Un appel place sans humain devant l'appareil est donc muet, et c'est la
 * definition meme d'un appel automatise — encadre au Canada par les Regles sur
 * les telecommunications non sollicitees du CRTC. La classe le permet parce
 * que l'exploitant l'a demande ; elle le trace integralement pour la meme
 * raison.
 *
 * <h2>Deux durees, et elles different</h2>
 *
 * <p>La mesure interne chronometre {@code OFFHOOK -> IDLE}. Pour un appel
 * SORTANT, {@code OFFHOOK} arrive des le debut de la composition : la duree
 * inclut donc la sonnerie, et depasse de quelques secondes celle que compte
 * l'operateur.
 *
 * <p>Le journal d'appels d'Android, lui, compte a partir de la reponse — le
 * chiffre facturable. Mais le lire exige {@code READ_CALL_LOG}, une permission
 * restreinte qui ouvre TOUT l'historique de l'appareil. Anodin sur un telephone
 * dedie a la passerelle, tres intrusif sur celui de quelqu'un. C'est pourquoi
 * elle est derriere un reglage, eteint par defaut, comme le corps des messages
 * dans le journal.
 */
public class PhoneCalls {

    private static final String TAG = "PhoneCalls";

    public static final String SOURCE_MANUAL = "manual";
    public static final String SOURCE_CLICK = "click";
    public static final String SOURCE_QUEUED = "queued";

    public static final String STATE_DIALING = "dialing";
    public static final String STATE_CONNECTED = "connected";
    public static final String STATE_ENDED = "ended";
    public static final String STATE_FAILED = "failed";

    /**
     * Delai laisse au systeme pour ecrire l'appel dans son journal.
     *
     * <p>Le journal n'est pas ecrit au moment ou l'appel se termine : le
     * fournisseur de contenu met un instant. Interroger trop tot renvoie
     * l'appel PRECEDENT, ce qui produirait une duree fausse et credible —
     * le pire des deux mondes.
     */
    private static final long CALL_LOG_SETTLE_MS = 2_500L;

    /**
     * Au-dela, un appel en composition est considere comme perdu.
     *
     * <p>Quatre-vingt-dix secondes : une sonnerie depasse rarement soixante,
     * et la messagerie repond avant. Plus court risquerait d'abandonner un
     * appel qui allait aboutir ; plus long laisserait la file bloquee.
     */
    private static final long DIALING_TIMEOUT_MS = 90_000L;

    private final Context context;
    private final SmsGatewayConfig config;
    private final SmsOutbox outbox;
    private final SmsJournal journal;

    /** Appel en cours, ou null. Un telephone n'en tient qu'un. */
    private String currentUuid;
    private String currentNumber;
    private String currentSource;
    private long offhookAt;
    /** Depuis quand un appel est en composition, pour ne pas l'y laisser. */
    private long dialingSince;
    private int lastState = TelephonyManager.CALL_STATE_IDLE;

    public PhoneCalls(Context context) {
        this.context = context.getApplicationContext();
        this.config = new SmsGatewayConfig(this.context);
        this.outbox = SmsOutbox.get(this.context);
        this.journal = new SmsJournal(this.context);
    }

    // ------------------------------------------------------------------
    // Placer un appel
    // ------------------------------------------------------------------

    /**
     * Compose un numero.
     *
     * @param uuid   identifiant cote serveur, ou null pour en creer un
     * @param source d'ou vient la demande — voir les constantes SOURCE_*
     * @return l'uuid de l'appel, ou null si le systeme a refuse
     */
    public String place(String number, String uuid, String source) {
        if (number == null || number.trim().isEmpty()) {
            return null;
        }
        if (!granted(Manifest.permission.CALL_PHONE)) {
            journal.error(SmsJournal.CAT_SEND,
                    "Permission d'appel refusee : aucun appel ne partira", uuid);
            return null;
        }
        String identifiant = uuid != null ? uuid
                : UUID.randomUUID().toString().replace("-", "");
        try {
            Intent intent = new Intent(Intent.ACTION_CALL);
            intent.setData(Uri.fromParts("tel", number.trim(), null));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (Exception e) {
            journal.error(SmsJournal.CAT_SEND,
                    "Appel impossible : " + e.getMessage(), identifiant);
            report(identifiant, number, source, STATE_FAILED, 0, null,
                    e.getMessage());
            return null;
        }
        // On retient l'appel AVANT que le systeme ne change d'etat : la
        // transition OFFHOOK peut arriver en quelques millisecondes, et un
        // appel non retenu serait compte comme « compose a la main ».
        currentUuid = identifiant;
        currentNumber = number.trim();
        currentSource = source != null ? source : SOURCE_CLICK;
        dialingSince = System.currentTimeMillis();
        journal.withDetail(SmsJournal.LEVEL_INFO, SmsJournal.CAT_SEND,
                "Appel lance (" + currentSource + ")", identifiant, currentNumber);
        report(identifiant, currentNumber, currentSource, STATE_DIALING, 0,
                null, null);
        return identifiant;
    }


    /**
     * Cloture un appel qui n'aboutit jamais.
     *
     * <p>Un appel refuse par le reseau AVANT que la ligne ne bouge ne produit
     * aucune transition d'etat : rien ne se declenche, et la fiche reste en
     * « composition » indefiniment. Observe en essai reel — un appel du
     * telephone vers lui-meme. Sans ce balai, une file d'appels se remplirait
     * de fiches eternellement en cours, et le prochain appel serait bloque par
     * une ligne que l'on croit occupee.
     */
    public void sweepStale() {
        if (currentUuid == null || dialingSince == 0L) {
            return;
        }
        long ecoule = System.currentTimeMillis() - dialingSince;
        if (ecoule < DIALING_TIMEOUT_MS) {
            return;
        }
        String uuid = currentUuid;
        String numero = currentNumber;
        String source = currentSource;
        currentUuid = null;
        currentNumber = null;
        currentSource = null;
        dialingSince = 0L;
        offhookAt = 0L;
        report(uuid, numero, source, STATE_FAILED, 0, null,
                "aucune reponse du reseau apres "
                        + (DIALING_TIMEOUT_MS / 1000) + " s");
        journal.warn(SmsJournal.CAT_SEND,
                "Appel abandonne : la ligne n'a jamais bouge", uuid);
    }

    // ------------------------------------------------------------------
    // Observer
    // ------------------------------------------------------------------

    /** Ecouteur a enregistrer tant que le service tourne. */
    public PhoneStateListener listener() {
        return new PhoneStateListener() {
            @Override
            public void onCallStateChanged(int state, String incomingNumber) {
                onState(state, incomingNumber);
            }
        };
    }

    /**
     * Traite un changement d'etat de la ligne.
     *
     * <p>Le decoupage est volontairement pauvre : IDLE, OFFHOOK, RINGING. On
     * ne cherche pas a distinguer « sonne » de « repond » — Android ne le dit
     * pas a une application ordinaire — donc on mesure ce qu'on peut mesurer
     * et on le nomme honnetement.
     */
    void onState(int state, String incomingNumber) {
        if (state == lastState) {
            return;
        }
        int precedent = lastState;
        lastState = state;

        if (state == TelephonyManager.CALL_STATE_RINGING) {
            // Appel entrant : on le retient pour le tracer s'il aboutit.
            if (currentUuid == null) {
                currentUuid = UUID.randomUUID().toString().replace("-", "");
                currentNumber = incomingNumber == null ? "" : incomingNumber;
                currentSource = SOURCE_MANUAL;
            }
            return;
        }

        if (state == TelephonyManager.CALL_STATE_OFFHOOK) {
            offhookAt = System.currentTimeMillis();
            dialingSince = 0L;
            if (currentUuid == null) {
                // Compose a la main sur le telephone : le serveur ne le
                // connait pas encore, c'est notre rapport qui le fera naitre.
                currentUuid = UUID.randomUUID().toString().replace("-", "");
                currentNumber = incomingNumber == null ? "" : incomingNumber;
                currentSource = SOURCE_MANUAL;
            }
            report(currentUuid, currentNumber, currentSource, STATE_CONNECTED,
                    0, null, null);
            journal.info(SmsJournal.CAT_SEND, "Appel en communication",
                    currentUuid);
            return;
        }

        if (state == TelephonyManager.CALL_STATE_IDLE && currentUuid != null) {
            long mesuree = offhookAt > 0
                    ? Math.max(0, (System.currentTimeMillis() - offhookAt) / 1000L)
                    : 0L;
            boolean jamaisDecroche = precedent != TelephonyManager.CALL_STATE_OFFHOOK;
            String uuid = currentUuid;
            String numero = currentNumber;
            String source = currentSource;
            currentUuid = null;
            currentNumber = null;
            currentSource = null;
            offhookAt = 0L;
            dialingSince = 0L;

            if (jamaisDecroche) {
                // La ligne est retombee sans jamais passer par OFFHOOK :
                // occupe, refuse, ou sans reponse. Ce n'est pas un appel de
                // duree nulle, c'est un appel qui n'a pas eu lieu.
                report(uuid, numero, source, STATE_FAILED, 0, null,
                        "sans reponse");
                journal.warn(SmsJournal.CAT_SEND, "Appel sans reponse", uuid);
                return;
            }
            finish(uuid, numero, source, mesuree);
        }
    }

    /**
     * Cloture un appel, en preferant la duree du journal quand elle est lisible.
     *
     * <p>Le rapport part dans tous les cas : le journal d'Android peut etre
     * indisponible, et une duree approchee vaut mieux qu'un appel sans trace.
     */
    private void finish(String uuid, String numero, String source, long mesuree) {
        long duree = mesuree;
        String origine = "measured";

        if (config.callLogDuration() && granted(Manifest.permission.READ_CALL_LOG)) {
            try {
                Thread.sleep(CALL_LOG_SETTLE_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            long exacte = callLogDuration(numero);
            if (exacte >= 0) {
                duree = exacte;
                origine = "call_log";
            }
        }
        report(uuid, numero, source, STATE_ENDED, duree, origine, null);
        journal.info(SmsJournal.CAT_SEND,
                "Appel termine — " + duree + " s (" + origine + ")", uuid);
    }

    /**
     * Duree du dernier appel avec ce numero, ou -1 si introuvable.
     *
     * <p>On filtre sur le numero plutot que de prendre la derniere ligne : sur
     * un telephone partage, un autre appel peut s'etre intercale, et lire la
     * mauvaise ligne donnerait un chiffre faux ET credible.
     */
    long callLogDuration(String numero) {
        if (numero == null || numero.isEmpty()) {
            return -1;
        }
        String[] colonnes = {CallLog.Calls.DURATION, CallLog.Calls.NUMBER};
        try (Cursor curseur = context.getContentResolver().query(
                CallLog.Calls.CONTENT_URI,
                colonnes,
                CallLog.Calls.NUMBER + " LIKE ?",
                new String[]{"%" + tail(numero)},
                CallLog.Calls.DATE + " DESC")) {
            if (curseur != null && curseur.moveToFirst()) {
                return curseur.getLong(0);
            }
        } catch (Exception e) {
            Log.w(TAG, "Journal d'appels illisible : " + e.getMessage());
        }
        return -1;
    }

    /**
     * Les sept derniers chiffres d'un numero.
     *
     * <p>Android normalise les numeros dans son journal — indicatif ajoute ou
     * retire, espaces, tirets. Comparer les chaines entieres raterait la
     * correspondance une fois sur deux ; comparer la fin la trouve.
     */
    private static String tail(String numero) {
        String chiffres = numero.replaceAll("[^0-9]", "");
        return chiffres.length() > 7
                ? chiffres.substring(chiffres.length() - 7)
                : chiffres;
    }

    // ------------------------------------------------------------------
    private void report(String uuid, String numero, String source, String state,
                        long duration, String durationSource, String reason) {
        try {
            org.json.JSONObject event = new org.json.JSONObject();
            event.put("uuid", uuid);
            event.put("number", numero == null ? "" : numero);
            event.put("source", source == null ? SOURCE_MANUAL : source);
            event.put("direction", "out");
            event.put("state", state);
            event.put("seq", outbox.nextSeq(uuid));
            event.put("at", System.currentTimeMillis() / 1000L);
            if (duration > 0) {
                event.put("duration", duration);
            }
            if (durationSource != null) {
                event.put("duration_source", durationSource);
            }
            if (reason != null) {
                event.put("reason", reason);
            }
            org.json.JSONArray calls = new org.json.JSONArray();
            calls.put(event);

            OdooReporter reporter = new OdooReporter(context);
            org.json.JSONObject payload = reporter.envelope();
            payload.put("calls", calls);
            reporter.submit(OdooReporter.ENDPOINT_REPORT, payload);
        } catch (Exception e) {
            Log.e(TAG, "Rapport d'appel impossible : " + e.getMessage());
        }
    }

    private boolean granted(String permission) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true;
        }
        return context.checkSelfPermission(permission)
                == PackageManager.PERMISSION_GRANTED;
    }
}
