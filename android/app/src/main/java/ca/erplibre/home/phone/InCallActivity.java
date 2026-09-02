package ca.erplibre.home.phone;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.telecom.Call;
import android.telecom.VideoProfile;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.TextView;

import java.lang.ref.WeakReference;

import ca.erplibre.home.R;

/**
 * Ecran d'appel, affiche quand l'application tient le role de composeur.
 *
 * <p>Quand {@link PhoneCallService} est lie, Telecom n'affiche plus l'ecran
 * d'appel du systeme : celui-ci est le seul. On le tient donc pour du code
 * critique, et on le garde deliberement pauvre — vues natives, aucun
 * chargement, aucune dependance sur le reste de l'application. Le bouton
 * « raccrocher » doit s'afficher meme si tout va mal ailleurs.
 */
public class InCallActivity extends Activity {

    /** Instance vivante, pour la rafraichir depuis le service. */
    private static WeakReference<InCallActivity> vivante;

    private final Handler handler = new Handler(Looper.getMainLooper());

    private TextView etat;
    private TextView numero;
    private TextView duree;
    private Button repondre;
    private Button hautParleur;
    private Button micro;

    /** Instant du decroche, pour le chronometre. 0 tant qu'on n'a pas repondu. */
    private long decrocheA;

    private final Runnable tic = new Runnable() {
        @Override
        public void run() {
            majDuree();
            handler.postDelayed(this, 1_000L);
        }
    };

    public static void ouvrir(Context context) {
        Intent i = new Intent(context, InCallActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(i);
    }

    public static void rafraichir() {
        InCallActivity a = vivante == null ? null : vivante.get();
        if (a != null) {
            a.runOnUiThread(a::peindre);
        }
    }

    public static void fermer() {
        InCallActivity a = vivante == null ? null : vivante.get();
        if (a != null) {
            a.runOnUiThread(a::finish);
        }
    }

    @Override
    protected void onCreate(Bundle etatSauve) {
        super.onCreate(etatSauve);
        // L'ecran doit s'allumer et passer par-dessus le verrouillage : un
        // appel qui arrive quand le telephone est pose ne doit pas rester
        // invisible.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(
                    WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                            | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        setContentView(R.layout.activity_in_call);
        vivante = new WeakReference<>(this);

        etat = findViewById(R.id.etiquette_etat);
        numero = findViewById(R.id.etiquette_numero);
        duree = findViewById(R.id.etiquette_duree);
        repondre = findViewById(R.id.bouton_repondre);
        hautParleur = findViewById(R.id.bouton_haut_parleur);
        micro = findViewById(R.id.bouton_micro);

        findViewById(R.id.bouton_raccrocher).setOnClickListener(v -> raccrocher());
        repondre.setOnClickListener(v -> {
            Call c = PhoneCallService.appelCourant();
            if (c != null) {
                c.answer(VideoProfile.STATE_AUDIO_ONLY);
            }
        });
        hautParleur.setOnClickListener(v -> basculerHautParleur());
        micro.setOnClickListener(v -> basculerMicro());

        peindre();
        handler.post(tic);
    }

    /**
     * Raccroche, puis ferme quoi qu'il arrive.
     *
     * <p>Si l'appel a disparu entre-temps, on ferme quand meme : laisser un
     * ecran d'appel ouvert sans appel derriere serait le pire des etats.
     */
    private void raccrocher() {
        Call c = PhoneCallService.appelCourant();
        try {
            if (c != null) {
                if (c.getState() == Call.STATE_RINGING) {
                    c.reject(false, null);
                } else {
                    c.disconnect();
                }
            }
        } finally {
            finish();
        }
    }

    private void basculerHautParleur() {
        AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
        if (am == null) {
            return;
        }
        boolean voulu = !am.isSpeakerphoneOn();
        // Par l'InCallService et non par AudioManager : en tant que composeur,
        // c'est Telecom qui route, et lui passer par-dessus rejouerait la
        // bataille d'arbitrage qu'on a mesuree.
        setAudioRoute(voulu
                ? android.telecom.CallAudioState.ROUTE_SPEAKER
                : android.telecom.CallAudioState.ROUTE_EARPIECE);
    }

    private void setAudioRoute(int route) {
        PhoneCallService s = ServiceHolder.service;
        if (s != null) {
            s.setAudioRoute(route);
        }
    }

    private void basculerMicro() {
        AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
        if (am == null) {
            return;
        }
        PhoneCallService s = ServiceHolder.service;
        if (s != null) {
            s.setMuted(!am.isMicrophoneMute());
        }
        peindre();
    }

    private void peindre() {
        Call c = PhoneCallService.appelCourant();
        if (c == null) {
            finish();
            return;
        }
        int s = c.getState();
        if (s == Call.STATE_ACTIVE && decrocheA == 0L) {
            decrocheA = System.currentTimeMillis();
        }
        repondre.setVisibility(
                s == Call.STATE_RINGING ? android.view.View.VISIBLE
                        : android.view.View.GONE);

        int libelle;
        switch (s) {
            case Call.STATE_RINGING: libelle = R.string.in_call_ringing; break;
            case Call.STATE_ACTIVE: libelle = R.string.in_call_active; break;
            case Call.STATE_DISCONNECTED: libelle = R.string.in_call_ended; break;
            default: libelle = R.string.in_call_dialing; break;
        }
        etat.setText(libelle);

        String tel = "";
        if (c.getDetails() != null && c.getDetails().getHandle() != null) {
            tel = c.getDetails().getHandle().getSchemeSpecificPart();
        }
        numero.setText(tel);
        majDuree();
    }

    private void majDuree() {
        if (decrocheA == 0L) {
            duree.setText("");
            return;
        }
        long s = (System.currentTimeMillis() - decrocheA) / 1000L;
        duree.setText(String.format("%d:%02d", s / 60, s % 60));
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(tic);
        if (vivante != null && vivante.get() == this) {
            vivante = null;
        }
        super.onDestroy();
    }

    /** Reference au service vivant, posee par lui-meme. */
    static final class ServiceHolder {
        static PhoneCallService service;

        private ServiceHolder() {
        }
    }
}
