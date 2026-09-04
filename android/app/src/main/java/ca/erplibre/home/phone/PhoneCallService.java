package ca.erplibre.home.phone;

import android.telecom.Call;
import android.telecom.InCallService;
import android.util.Log;

import ca.erplibre.home.SmsJournal;

/**
 * Ecoute les appels quand l'application tient le role de composeur.
 *
 * <p>C'est la SEULE facon, pour une application qui n'est pas signee par la
 * plateforme, de savoir a quel instant le correspondant DECROCHE. L'etat de
 * ligne ordinaire ({@code PhoneStateListener}) ne le dit pas : pour un appel
 * sortant, {@code OFFHOOK} arrive des la composition, et Telecom range
 * {@code DIALING} et {@code ACTIVE} sous la meme constante. La transition qui
 * nous interesse n'emet aucun evenement. Ici, {@link Call#STATE_ACTIVE} la
 * donne exactement.
 *
 * <p>ATTENTION — consequence a ne jamais perdre de vue : des lors que ce
 * service est lie, Telecom cesse d'afficher l'ecran d'appel du systeme et
 * affiche le NOTRE. Si celui-ci est incomplet ou plante, quelqu'un se retrouve
 * en communication sans bouton pour raccrocher. Tout ce qui est ajoute ici doit
 * etre tenu pour du code critique.
 */
public class PhoneCallService extends InCallService {

    private static final String TAG = "PhoneCallService";

    /** L'appel en cours, partage avec l'ecran. Un seul a la fois suffit ici. */
    private static Call appelCourant;

    private SmsJournal journal;

    public static Call appelCourant() {
        return appelCourant;
    }

    private final Call.Callback rappel = new Call.Callback() {
        @Override
        public void onStateChanged(Call call, int state) {
            noter(state);
            InCallActivity.rafraichir();
        }
    };

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        // Telecom nous delie : l'ecran ne doit plus croire pouvoir router
        // l'audio par un service qui n'existe plus.
        InCallActivity.ServiceHolder.service = null;
        return super.onUnbind(intent);
    }

    @Override
    public void onCallAdded(Call call) {
        super.onCallAdded(call);
        // L'ecran a besoin du service pour router l'audio et couper le micro :
        // en tant que composeur, c'est Telecom qui commande, pas AudioManager.
        InCallActivity.ServiceHolder.service = this;
        appelCourant = call;
        if (journal == null) {
            journal = new SmsJournal(this);
        }
        call.registerCallback(rappel);
        noter(call.getState());
        InCallActivity.ouvrir(this);
    }

    @Override
    public void onCallRemoved(Call call) {
        super.onCallRemoved(call);
        call.unregisterCallback(rappel);
        // IDEMPOTENT : Telecom lie plusieurs instances de ce service, et
        // chacune recoit ce rappel — mesure du 30 aout, trois lignes « appel
        // retire » pour un seul appel. Sans ce garde-fou, la premiere instance
        // remet `appelCourant` a null et les suivantes agissent dans le vide.
        // Sur un composant qui commande l'ecran d'appel, une action rejouee
        // n'est pas un detail.
        if (appelCourant != call) {
            return;
        }
        appelCourant = null;
        if (journal != null) {
            journal.info(SmsJournal.CAT_SERVICE, "Composeur : appel retire", null);
        }
        InCallActivity.fermer();
    }

    /**
     * Consigne l'etat, en NOMMANT le decroche.
     *
     * <p>C'est la mesure que la sonde doit produire : voir apparaitre
     * {@code ACTIVE} a l'instant ou la personne repond, et non des la
     * composition comme le fait l'etat de ligne ordinaire.
     */
    private void noter(int state) {
        String nom;
        switch (state) {
            case Call.STATE_CONNECTING: nom = "CONNECTING (etablissement)"; break;
            case Call.STATE_DIALING: nom = "DIALING (composition)"; break;
            case Call.STATE_RINGING: nom = "RINGING (appel entrant)"; break;
            case Call.STATE_ACTIVE: nom = "ACTIVE — DECROCHE"; break;
            case Call.STATE_HOLDING: nom = "HOLDING (en attente)"; break;
            case Call.STATE_DISCONNECTING: nom = "DISCONNECTING"; break;
            case Call.STATE_DISCONNECTED: nom = "DISCONNECTED (termine)"; break;
            case Call.STATE_SELECT_PHONE_ACCOUNT: nom = "SELECT_PHONE_ACCOUNT"; break;
            default: nom = "etat " + state; break;
        }
        Log.i(TAG, "etat : " + nom);
        if (journal != null) {
            journal.info(SmsJournal.CAT_SERVICE, "Composeur : " + nom, null);
        }
    }
}
