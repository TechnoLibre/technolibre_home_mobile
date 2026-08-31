package ca.erplibre.home;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.CallLog;
import android.telecom.TelecomManager;
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
    private final CallAudio callAudio;

    /**
     * Fil unique pour la cloture des appels.
     *
     * <p>Un seul : deux clotures simultanees liraient le journal d'Android en
     * meme temps, et rien ne garantit laquelle verrait la bonne ligne.
     */
    private final java.util.concurrent.ExecutorService finisseur =
            java.util.concurrent.Executors.newSingleThreadExecutor();

    /**
     * Dernier etat vu de la ligne, pour ne traiter que les CHANGEMENTS.
     *
     * <p>Seul rescape en memoire, et sans consequence s'il se perd : au pire
     * on retraite une transition, ce que la table absorbe. Tout ce qui compte
     * — quel appel, depuis quand, decroche ou non — vit dans SQLite.
     */
    private int lastState = TelephonyManager.CALL_STATE_IDLE;

    public PhoneCalls(Context context) {
        this.context = context.getApplicationContext();
        this.config = new SmsGatewayConfig(this.context);
        this.outbox = SmsOutbox.get(this.context);
        this.journal = new SmsJournal(this.context);
        this.callAudio = new CallAudio(this.context);
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
        String echec = compose(number.trim());
        if (echec != null) {
            journal.error(SmsJournal.CAT_SEND,
                    "Appel impossible : " + echec, identifiant);
            report(identifiant, number, source, STATE_FAILED, 0, null, echec);
            return null;
        }
        // On ouvre le suivi AVANT que le systeme ne change d'etat : la
        // transition OFFHOOK peut arriver en quelques millisecondes, et un
        // appel non enregistre serait compte comme « compose a la main ».
        String origine = source != null ? source : SOURCE_CLICK;
        outbox.callStart(identifiant, number.trim(), origine);
        journal.withDetail(SmsJournal.LEVEL_INFO, SmsJournal.CAT_SEND,
                "Appel lance (" + origine + ")", identifiant, number.trim());
        report(identifiant, number.trim(), origine, STATE_DIALING, 0,
                null, null);
        return identifiant;
    }


    /**
     * Compose reellement le numero. Renvoie null si c'est parti, sinon le motif.
     *
     * <h3>Pourquoi pas {@code startActivity(ACTION_CALL)}</h3>
     *
     * <p>C'etait l'implementation precedente, et Android la refusait EN
     * SILENCE. Depuis Android 10, une application ne peut plus demarrer une
     * activite depuis l'arriere-plan, et un service de premier plan ne donne
     * PAS ce droit. Trace systeme relevee sur appareil :
     *
     * <pre>
     * W/ActivityTaskManager: Background activity start
     *   [callingPackage: ca.erplibre.home;
     *    callingUidHasAnyVisibleWindow: false;
     *    callingUidProcState: FOREGROUND_SERVICE;
     *    isBgStartWhitelisted: false;
     *    intent: act=android.intent.action.CALL ...]
     * </pre>
     *
     * <p>Aucune exception n'etait levee : l'intention partait, personne ne la
     * traitait, et la ligne ne bougeait jamais. Le seul symptome etait un
     * appel qui restait en composition jusqu'a expiration — un echec muet, le
     * pire genre.
     *
     * <p>{@link TelecomManager#placeCall} est l'API prevue pour cela. Elle ne
     * demarre pas d'activite : elle s'adresse au sous-systeme telephonique,
     * qui affiche lui-meme l'ecran d'appel. Elle fonctionne donc depuis un
     * service.
     */
    private String compose(String numero) {
        Uri cible = Uri.fromParts("tel", numero, null);
        try {
            TelecomManager telecom =
                    context.getSystemService(TelecomManager.class);
            if (telecom != null) {
                telecom.placeCall(cible, null);
                return null;
            }
        } catch (SecurityException e) {
            return "permission refusee : " + e.getMessage();
        } catch (Exception e) {
            Log.w(TAG, "placeCall a echoue : " + e.getMessage());
        }
        // Repli pour les cas ou Telecom est indisponible. Il echouera depuis
        // l'arriere-plan sur Android 10+, mais il vaut mieux tenter que rien.
        try {
            Intent intent = new Intent(Intent.ACTION_CALL, cible);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            return null;
        } catch (Exception e) {
            return String.valueOf(e.getMessage());
        }
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
        for (SmsOutbox.Call perdu : outbox.callsStale(DIALING_TIMEOUT_MS)) {
            // Rapporter AVANT de fermer : la numerotation s'appuie sur la
            // ligne, et la supprimer d'abord ferait perdre le rang.
            report(perdu.uuid, perdu.number, perdu.source, STATE_FAILED, 0,
                    null, "aucune reponse du reseau apres "
                            + (DIALING_TIMEOUT_MS / 1000) + " s");
            outbox.callFinish(perdu.uuid);
            journal.warn(SmsJournal.CAT_SEND,
                    "Appel abandonne : la ligne n'a jamais bouge", perdu.uuid);
        }
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

        SmsOutbox.Call actif = outbox.activeCall();

        if (state == TelephonyManager.CALL_STATE_RINGING) {
            if (actif == null) {
                // Appel entrant : on ouvre le suivi ET on previent Odoo tout
                // de suite. L'interet d'afficher la fiche de l'appelant est de
                // l'avoir sous les yeux PENDANT qu'il parle : rapporter a la
                // fin ne servirait a rien.
                String uuid = UUID.randomUUID().toString().replace("-", "");
                String numero = incomingNumber == null ? "" : incomingNumber;
                outbox.callStart(uuid, numero, SOURCE_MANUAL);
                if (numero.isEmpty()) {
                    // Android 10+ masque le numero sans READ_CALL_LOG. On le
                    // dit une fois plutot que de laisser croire a une panne
                    // d'Odoo ou de rapprochement.
                    journal.warn(SmsJournal.CAT_SEND,
                            "Numero entrant masque par Android : accordez la"
                                    + " lecture du journal d'appels pour"
                                    + " identifier l'appelant", uuid);
                }
                reportIncoming(uuid, numero);
            }
            return;
        }

        if (state == TelephonyManager.CALL_STATE_OFFHOOK) {
            if (actif == null) {
                // Compose a la main sur le telephone : le serveur ne le
                // connait pas encore, c'est notre rapport qui le fera naitre.
                String uuid = UUID.randomUUID().toString().replace("-", "");
                outbox.callStart(uuid,
                        incomingNumber == null ? "" : incomingNumber,
                        SOURCE_MANUAL);
                actif = outbox.activeCall();
            }
            if (actif == null) {
                return;
            }
            outbox.callOffhook(actif.uuid, System.currentTimeMillis());
            report(actif.uuid, actif.number, actif.source, STATE_CONNECTED,
                    0, null, null);
            journal.info(SmsJournal.CAT_SEND, "Appel en communication",
                    actif.uuid);
            // A OFFHOOK et pas avant : diffuser pendant la sonnerie ne ferait
            // que jouer pour nous-memes. Sans effet si la demonstration est
            // desactivee, ce qui est le defaut.
            //
            // SORTANTS SEULEMENT. Un appel entrant passe par RINGING avant
            // OFFHOOK : venir de cet etat, c'est avoir DECROCHE. Envoyer la
            // melodie de demonstration a quelqu'un qui appelle l'ecole serait
            // au mieux incomprehensible, au pire pris pour une plaisanterie —
            // et l'oubli d'un interrupteur ne doit pas pouvoir faire ca.
            if (precedent != TelephonyManager.CALL_STATE_RINGING) {
                callAudio.start(actif.uuid);
            }
            return;
        }

        if (state == TelephonyManager.CALL_STATE_IDLE) {
            // Inconditionnel, et place en tete : la ligne est retombee, donc
            // la melodie doit se taire et le haut-parleur revenir a son etat
            // d'origine, quoi qu'il arrive ensuite. Le faire plus bas
            // laisserait le telephone sur haut-parleur si un rapport echoue.
            callAudio.stop(actif == null ? null : actif.uuid);
        }

        if (state == TelephonyManager.CALL_STATE_IDLE && actif != null) {
            boolean jamaisDecroche =
                    precedent != TelephonyManager.CALL_STATE_OFFHOOK
                            || actif.offhookAt <= 0L;
            if (jamaisDecroche) {
                // La ligne est retombee sans jamais passer par OFFHOOK :
                // occupe, refuse, ou sans reponse. Ce n'est pas un appel de
                // duree nulle, c'est un appel qui n'a pas eu lieu.
                report(actif.uuid, actif.number, actif.source, STATE_FAILED,
                        0, null, "sans reponse");
                outbox.callFinish(actif.uuid);
                journal.warn(SmsJournal.CAT_SEND, "Appel sans reponse",
                        actif.uuid);
                return;
            }
            long mesuree = Math.max(
                    0, (System.currentTimeMillis() - actif.offhookAt) / 1000L);
            finish(actif.uuid, actif.number, actif.source, mesuree,
                    actif.offhookAt);
            outbox.callFinish(actif.uuid);
        }
    }

    /**
     * Cloture un appel, en preferant la duree du journal quand elle est lisible.
     *
     * <p>Le rapport part dans tous les cas : le journal d'Android peut etre
     * indisponible, et une duree approchee vaut mieux qu'un appel sans trace.
     */
    private void finish(String uuid, String numero, String source, long mesuree,
                        long depuis) {
        if (!config.callLogDuration() || !granted(Manifest.permission.READ_CALL_LOG)) {
            // Sans le journal d'Android, on ne peut RIEN dire du decroche : on
            // rapporte la mesure telle quelle, en la nommant honnetement.
            report(uuid, numero, source, STATE_ENDED, mesuree, "measured", null);
            journal.info(SmsJournal.CAT_SEND,
                    "Appel termine — " + mesuree + " s (measured)", uuid);
            return;
        }
        // Hors du fil principal : l'attente que le systeme ecrive son journal
        // durait 2,5 s, et elle se produisait dans le rappel du
        // PhoneStateListener — donc sur le fil de l'interface, qu'elle gelait.
        finisseur.execute(
                () -> finishAvecJournal(uuid, numero, source, mesuree, depuis));
    }

    /**
     * Cloture en consultant le journal d'Android, hors du fil principal.
     *
     * <p>Le journal ne sert pas qu'a preciser la duree : il dit aussi si
     * l'appel a ete DECROCHE. Telecom compte `duration` depuis l'instant de
     * connexion et laisse 0 quand la connexion n'a jamais eu lieu — donc
     * `duration == 0` signifie « personne n'a repondu », et c'est une
     * classification, pas seulement un chiffre.
     *
     * <p>Cela repare un defaut reel : pour un appel SORTANT, l'etat OFFHOOK
     * arrive des la composition, si bien que le garde-fou `jamaisDecroche` ne
     * se declenchait jamais. Un appel qui avait sonne dans le vide etait
     * rapporte a Odoo comme REUSSI, d'une duree egale au temps de sonnerie.
     */
    private void finishAvecJournal(String uuid, String numero, String source,
                                   long mesuree, long depuis) {
        long exacte = attendreLigneDuJournal(numero, depuis);

        if (exacte == 0L) {
            report(uuid, numero, source, STATE_FAILED, 0, "call_log",
                    "sans reponse");
            journal.warn(SmsJournal.CAT_SEND,
                    "Appel sans reponse — " + mesuree + " s de sonnerie."
                            + " Le journal d'Android donne une duree nulle :"
                            + " personne n'a decroche.", uuid);
            return;
        }

        long duree = mesuree;
        String origine = "measured";
        if (exacte > 0L) {
            duree = exacte;
            origine = "call_log";
        }
        report(uuid, numero, source, STATE_ENDED, duree, origine, null);
        journal.info(SmsJournal.CAT_SEND,
                "Appel termine — " + duree + " s (" + origine + ")", uuid);
    }

    /**
     * Attend que le systeme ait ecrit LA ligne de CET appel, puis la lit.
     *
     * <p>Un delai fixe de 2,5 s ne suffisait pas : deux appels de suite vers le
     * meme numero ont rendu la MEME duree de 60 s, alors que le second avait ete
     * refuse et valait zero. La requete, filtree sur le seul numero et triee par
     * date, rendait la ligne du PRECEDENT appel — un chiffre faux et credible,
     * exactement ce que le commentaire de {@link #callLogDuration} annoncait.
     *
     * <p>On attend donc une ligne plus recente que le debut de l'appel, au lieu
     * de parier sur un delai. Sept secondes au total : au-dela, mieux vaut
     * rapporter la mesure interne que de retenir un rapport indefiniment.
     */
    private long attendreLigneDuJournal(String numero, long depuis) {
        long echeance = System.currentTimeMillis() + 7_000L;
        while (System.currentTimeMillis() < echeance) {
            try {
                Thread.sleep(CALL_LOG_SETTLE_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return -1;
            }
            long duree = callLogDuration(numero, depuis);
            if (duree >= 0) {
                return duree;
            }
        }
        return -1;
    }

    /**
     * Duree du dernier appel avec ce numero, ou -1 si introuvable.
     *
     * <p>On filtre sur le numero plutot que de prendre la derniere ligne : sur
     * un telephone partage, un autre appel peut s'etre intercale, et lire la
     * mauvaise ligne donnerait un chiffre faux ET credible.
     */
    long callLogDuration(String numero, long depuis) {
        if (numero == null || numero.isEmpty()) {
            return -1;
        }
        String[] colonnes = {CallLog.Calls.DURATION, CallLog.Calls.NUMBER};
        // La marge de 2 s absorbe l'ecart entre notre horloge et celle que le
        // systeme inscrit dans sa ligne ; sans elle on rejetterait la bonne.
        String depuisTexte = String.valueOf(Math.max(0, depuis - 2_000L));
        try (Cursor curseur = context.getContentResolver().query(
                CallLog.Calls.CONTENT_URI,
                colonnes,
                CallLog.Calls.NUMBER + " LIKE ? AND "
                        + CallLog.Calls.DATE + " >= ?",
                new String[]{"%" + tail(numero), depuisTexte},
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

    /** Annonce un appel entrant, des la sonnerie. */
    private void reportIncoming(String uuid, String numero) {
        try {
            org.json.JSONObject event = new org.json.JSONObject();
            event.put("uuid", uuid);
            event.put("number", numero);
            event.put("source", SOURCE_MANUAL);
            event.put("direction", "in");
            event.put("state", STATE_DIALING);
            event.put("seq", outbox.nextCallSeq(uuid));
            event.put("at", System.currentTimeMillis() / 1000L);
            org.json.JSONArray calls = new org.json.JSONArray();
            calls.put(event);
            OdooReporter reporter = new OdooReporter(context);
            org.json.JSONObject payload = reporter.envelope();
            payload.put("calls", calls);
            reporter.submit(OdooReporter.ENDPOINT_REPORT, payload);
        } catch (Exception e) {
            Log.e(TAG, "Annonce d'appel entrant impossible : " + e.getMessage());
        }
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
            event.put("seq", outbox.nextCallSeq(uuid));
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
