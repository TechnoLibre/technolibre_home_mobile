package ca.erplibre.home;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

/**
 * Diffuse une melodie pendant un appel, par COUPLAGE ACOUSTIQUE.
 *
 * <p>CONCLUSION DE L'ESSAI DU 30 AOUT 2026 : CE MONTAGE NE FONCTIONNE PAS.
 * Le correspondant n'entend rien. Ce qu'on entendait etait le haut-parleur du
 * telephone dans la piece, pas la melodie transmise par l'appel.
 *
 * <p>La cause est structurelle et mesuree, pas un reglage a trouver : le micro
 * n'est PAS coupe (verifie sur l'appareil :
 * {@code mic mute FromSwitch=false FromRestrictions=false FromApi=false
 * from system=false}) et le routage haut-parleur EST obtenu (le journal le dit
 * a chaque essai). Mais le pipeline voix applique une annulation d'echo dont le
 * travail exact est de soustraire du flux montant ce que l'appareil vient
 * d'emettre. Notre melodie sort du haut-parleur de cet appareil : l'AEC en
 * possede donc le signal de reference, et la retire.
 *
 * <p>Une source EXTERNE passerait, faute de reference — mais alors ce n'est
 * plus l'application qui joue, c'est un haut-parleur pose a cote du telephone.
 * Le code reste, desactive par defaut, comme trace de ce qui a ete mesure.
 *
 * <p>C'est un montage de demonstration, et il faut le dire franchement :
 * Android n'expose AUCUNE interface permettant d'injecter du son dans le flux
 * montant d'un appel cellulaire. Ce flux appartient au modem. Le seul moyen
 * qu'a une application ordinaire de faire entendre quelque chose au
 * correspondant est de le jouer dans le haut-parleur et de laisser le
 * microphone le reprendre.
 *
 * <p>Le pipeline voix applique une annulation d'echo dont le travail est
 * precisement de supprimer le son que l'appareil vient d'emettre. Elle
 * combat donc activement ce montage. Le resultat s'entend, etouffe et a
 * niveau instable. C'est bon pour une demonstration et pour rien d'autre :
 * ne jamais s'en servir pour une annonce a des membres.
 *
 * <p>Deuxieme limite, de version : {@code setSpeakerphoneOn} est deprecie
 * depuis l'API 31, et sur Android recent le routage d'un appel telephonique
 * appartient a l'application telephone, pas a nous. On tente, puis on VERIFIE
 * ce qui s'est reellement produit et on le journalise. Annoncer un succes
 * sans le verifier serait mentir sur la seule chose qui compte ici.
 */
public class CallAudio {

    private static final String TAG = "CallAudio";

    private final Context context;
    private final SmsGatewayConfig config;
    private final SmsJournal journal;
    private final AudioManager audio;

    private MediaPlayer lecteur;
    private final Handler handler = new Handler(Looper.getMainLooper());

    /**
     * Periode de re-affirmation du routage, en millisecondes.
     *
     * <p>Mesure sur Pixel 2 XL (Android 11), horodatee dans dumpsys :
     * <pre>
     * 02:38:33.120  setForceUse(FOR_COMMUNICATION, FORCE_SPEAKER)  &lt;- accorde
     * 02:38:34.245  setForceUse(FOR_COMMUNICATION, FORCE_NONE)     &lt;- repris
     * </pre>
     * Le haut-parleur est accorde a notre demande puis REPRIS 1,1 s plus tard
     * par l'application telephone, qui possede le routage pendant un appel
     * cellulaire. Une demande unique ne tient donc pas : on la redemande tant
     * que la melodie joue.
     *
     * <p>Une seconde : plus court userait la batterie et multiplierait les
     * a-coups audibles, plus long laisserait des trous ou le correspondant
     * n'entend rien. C'est un compromis de DEMONSTRATION, et il faut le dire :
     * lutter contre l'application telephone donne un resultat hachure, propre
     * a cet appareil, et qui peut cesser de fonctionner a la prochaine version
     * d'Android.
     */
    private static final long PERIODE_RELANCE_MS = 1_000L;

    // NE PAS demander le focus audio ici. Essai du 30 aout : une demande
    // AUDIOFOCUS_GAIN_TRANSIENT en USAGE_MEDIA n'a pas ameliore le routage — il
    // etait deja obtenu, le journal le dit — et le correspondant a cesse
    // d'entendre la melodie qu'il entendait avant. Se declarer client media
    // pendant une communication invite le systeme a attenuer ce media, ce qui
    // est exactement le contraire du but.

    /**
     * Duree apres laquelle la melodie repart de son debut, en millisecondes.
     *
     * <p>Android ne dit PAS a une application ordinaire quand le correspondant
     * decroche : pour un appel sortant, l'etat OFFHOOK arrive des la
     * composition. La seule API qui distingue « ca sonne » de « on a repondu »
     * est {@code PreciseCallState}, protegee en {@code signature|privileged} —
     * verifie sur l'appareil d'essai : la permission est declarable mais jamais
     * accordee, et {@code pm grant} la refuse.
     *
     * <p>On ne peut donc pas demarrer au decroche. Mais on n'en a pas besoin :
     * tant que ca sonne, la liaison montante n'est pas raccordee et PERSONNE
     * n'entend la melodie. Le seul defaut audible est que la personne decroche
     * au milieu. On le supprime en redemarrant la melodie du debut a intervalle
     * regulier : ou que tombe le decroche, ce qui suit est un debut.
     *
     * <p>Douze secondes : plus long laisserait entendre un morceau tronque,
     * plus court hacherait la melodie de trois secondes qu'on joue.
     */
    private static final long REPRISE_DEPUIS_DEBUT_MS = 12_000L;

    /** Etat a restaurer : on ne laisse pas le telephone sur haut-parleur. */
    private boolean speakerAvant;
    private boolean actif;

    /** Dernier etat CONNU du routage, pour ne journaliser que les changements. */
    private boolean routageObtenu;
    /** Nombre de reprises subies, pour le dire une fois a la fin. */
    private int reprises;

    /** Instant du debut de la melodie, pour dater les reprises. */
    private long debutMs;


    /**
     * Pause avant de relire l'etat du haut-parleur, en millisecondes.
     *
     * <p>Courte a dessein : elle s'execute dans la boucle de re-affirmation,
     * qui tourne sur le fil principal. Cinquante millisecondes ne se voient pas
     * a l'ecran et suffisent a laisser passer un aller-retour de binder.
     */
    private static final long RELECTURE_MS = 50L;

    /** Le decalage de lecture a-t-il deja ete signale ? Une fois suffit. */
    private boolean lectureTardiveVue;

    public CallAudio(Context context) {
        this.context = context.getApplicationContext();
        this.config = new SmsGatewayConfig(this.context);
        this.journal = new SmsJournal(this.context);
        this.audio = (AudioManager)
                this.context.getSystemService(Context.AUDIO_SERVICE);
    }

    /**
     * Demarre la diffusion, si la demonstration est activee.
     *
     * @param uuid appel concerne, pour le journal
     */
    public synchronized void start(String uuid) {
        if (!config.demoCallAudio() || audio == null || actif) {
            return;
        }
        actif = true;
        reprises = 0;
        debutMs = System.currentTimeMillis();
        lectureTardiveVue = false;
        routageObtenu = false;
        speakerAvant = audio.isSpeakerphoneOn();

        boolean hautParleur = forcerHautParleur();
        routageObtenu = hautParleur;
        // Dans les DEUX cas : accorde, il sera repris ; refuse, il peut etre
        // accorde plus tard. La boucle couvre les deux.
        programmerRelance(uuid);

        try {
            lecteur = MediaPlayer.create(context, R.raw.demo_musique);
            if (lecteur == null) {
                journal.warn(SmsJournal.CAT_SEND,
                        "Demonstration audio : melodie illisible", uuid);
                restaurer();
                return;
            }
            // USAGE_MEDIA et non VOICE_COMMUNICATION : ce dernier passe par le
            // chemin voix, ou l'annulation d'echo l'attend. On veut au
            // contraire sortir par le haut-parleur comme de la musique.
            lecteur.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build());
            lecteur.setLooping(true);
            lecteur.start();
            programmerReprise(uuid);
            journal.info(SmsJournal.CAT_SEND,
                    hautParleur
                            ? "Demonstration audio : melodie en diffusion"
                            + " (couplage acoustique, qualite degradee)"
                            : "Demonstration audio : melodie lancee, routage"
                            + " haut-parleur pas encore obtenu",
                    uuid);
        } catch (IllegalStateException | SecurityException e) {
            Log.w(TAG, "lecture impossible", e);
            journal.warn(SmsJournal.CAT_SEND,
                    "Demonstration audio impossible : " + e, uuid);
            restaurer();
        }
    }

    /** Arrete la diffusion et REMET l'audio comme on l'a trouve. */
    public synchronized void stop(String uuid) {
        if (!actif) {
            return;
        }
        // Avant tout : plus aucune retente ne doit rallumer le haut-parleur
        // apres la fin de l'appel.
        actif = false;
        handler.removeCallbacksAndMessages(null);
        if (lecteur != null) {
            try {
                lecteur.stop();
            } catch (IllegalStateException ignored) {
                // Deja arrete : sans consequence, on libere quand meme.
            }
            lecteur.release();
            lecteur = null;
            journal.info(SmsJournal.CAT_SEND,
                    reprises > 0
                            ? "Demonstration audio : melodie arretee."
                            + " L'application telephone a repris le"
                            + " haut-parleur " + reprises + " fois pendant"
                            + " l'appel : le son a ete hache."
                            : "Demonstration audio : melodie arretee",
                    uuid);
        }
        restaurer();
    }

    /**
     * Ramene periodiquement la melodie a son debut.
     *
     * <p>Voir {@link #REPRISE_DEPUIS_DEBUT_MS} : faute de pouvoir demarrer au
     * decroche, on fait en sorte que l'instant du decroche n'ait pas
     * d'importance.
     */
    private void programmerReprise(String uuid) {
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!actif || lecteur == null) {
                    return;
                }
                try {
                    lecteur.seekTo(0);
                } catch (IllegalStateException e) {
                    // Lecteur libere entre-temps : l'appel est fini, il n'y a
                    // rien a reprendre.
                    return;
                }
                handler.postDelayed(this, REPRISE_DEPUIS_DEBUT_MS);
            }
        }, REPRISE_DEPUIS_DEBUT_MS);
    }

    /**
     * Redemande le haut-parleur tant que la melodie joue.
     *
     * <p>On ne journalise que les CHANGEMENTS. A une verification par seconde,
     * ecrire chaque passage produirait une centaine de lignes par appel et
     * rendrait le journal illisible — alors que ce qu'on veut savoir tient en
     * deux faits : est-ce que le routage a fini par tenir, et combien de fois
     * l'application telephone l'a repris.
     */
    private void programmerRelance(String uuid) {
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!actif) {
                    return;
                }
                boolean avant = routageObtenu;
                routageObtenu = forcerHautParleur();
                if (routageObtenu && !avant) {
                    journal.info(SmsJournal.CAT_SEND,
                            "Demonstration audio : haut-parleur repris,"
                                    + " melodie de nouveau audible", uuid);
                } else if (!routageObtenu && avant) {
                    reprises++;
                    // On DATE la reprise. Hypothese a verifier : l'application
                    // telephone reaffirme son routage quand l'appel change
                    // d'etat, et le decroche EST ce changement. Si l'instant
                    // colle a la duree de conversation que rapporte le journal
                    // d'Android, on tient un detecteur de decroche la ou
                    // l'API n'en offre aucun.
                    journal.info(SmsJournal.CAT_SEND,
                            "Demonstration audio : haut-parleur repris par le"
                                    + " telephone a "
                                    + ((System.currentTimeMillis() - debutMs)
                                       / 1000L)
                                    + " s apres le debut de la melodie",
                            uuid);
                }
                handler.postDelayed(this, PERIODE_RELANCE_MS);
            }
        }, PERIODE_RELANCE_MS);
    }

    /**
     * Tente le haut-parleur et rapporte ce qui s'est REELLEMENT produit.
     *
     * @return vrai seulement si le systeme confirme le routage
     */
    private boolean forcerHautParleur() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // API 31+ : la voie officielle. Elle est prevue pour les
                // appels que l'application gere elle-meme ; sur un appel
                // cellulaire elle peut simplement ne rien faire, d'ou la
                // verification qui suit.
                for (AudioDeviceInfo appareil : audio.getAvailableCommunicationDevices()) {
                    if (appareil.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                        boolean ok = audio.setCommunicationDevice(appareil);
                        if (ok) {
                            return true;
                        }
                        break;
                    }
                }
            }
            // Voie historique, depreciee mais seule disponible sous API 31 et
            // parfois seule efficace au-dessus.
            audio.setSpeakerphoneOn(true);
            boolean immediat = audio.isSpeakerphoneOn();
            if (immediat) {
                return true;
            }
            // Deuxieme lecture apres une courte pause. `setSpeakerphoneOn`
            // traverse un binder jusqu'a AudioService puis AudioDeviceBroker :
            // rien ne garantit que l'etat lu dans la foulee soit deja a jour.
            // Conclure au refus sur la lecture immediate produirait un faux
            // negatif — et c'est exactement le symptome observe, ou le routage
            // est declare refuse sur certains appels sans qu'aucune autre
            // condition ne change.
            try {
                Thread.sleep(RELECTURE_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
            boolean apresPause = audio.isSpeakerphoneOn();
            if (apresPause && !lectureTardiveVue) {
                lectureTardiveVue = true;
                journal.info(SmsJournal.CAT_SEND,
                        "Demonstration audio : le routage n'etait pas encore"
                                + " visible a la lecture immediate, mais l'est"
                                + " apres " + RELECTURE_MS + " ms.", null);
            }
            return apresPause;
        } catch (SecurityException | IllegalArgumentException e) {
            Log.w(TAG, "haut-parleur refuse", e);
            return false;
        }
    }

    private void restaurer() {
        actif = false;
        if (audio == null) {
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                audio.clearCommunicationDevice();
            }
            audio.setSpeakerphoneOn(speakerAvant);
            // On ne repose PAS le mode : mesure sur l'appareil, notre paquet
            // n'apparait pas une seule fois dans l'historique des setMode de
            // `dumpsys audio`. Telecom possede le mode pendant un appel, notre
            // appel etait donc ignore en silence — et le reposer APRES la fin
            // de l'appel n'aurait de toute facon aucun sens.
        } catch (SecurityException | IllegalArgumentException e) {
            // Ne jamais laisser une restauration ratee masquer la fin de
            // l'appel : on le note et on passe.
            Log.w(TAG, "restauration audio incomplete", e);
        }
    }
}
