package ca.erplibre.home.phone;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;

/**
 * Repond a {@code ACTION_DIAL}, condition pour tenir le role de composeur.
 *
 * <p>Verifie sur l'appareil d'essai : les {@code required-components} du role
 * {@code android.app.role.DIALER} sont exactement deux activites
 * {@code ACTION_DIAL} — une nue, une avec {@code scheme="tel"}. Sans elles, le
 * role ne peut PAS etre demande.
 *
 * <p>Cette sonde ne fournit pas de clavier : quand quelqu'un compose un numero
 * depuis une autre application, on le PASSE au composeur du systeme plutot que
 * de faire semblant. Une sonde qui pretendrait remplacer le clavier sans
 * l'avoir ecrit rendrait le telephone inutilisable — ce qui est exactement le
 * risque contre lequel on se premunit.
 */
public class DialerActivity extends Activity {

    private static final String TAG = "DialerActivity";

    @Override
    protected void onCreate(Bundle etatSauve) {
        super.onCreate(etatSauve);
        Uri numero = getIntent() == null ? null : getIntent().getData();

        // On relaie vers l'application telephone preinstallee, en la nommant
        // explicitement pour ne pas se rappeler soi-meme.
        try {
            Intent relais = new Intent(Intent.ACTION_DIAL);
            if (numero != null) {
                relais.setData(numero);
            }
            relais.setPackage("com.google.android.dialer");
            relais.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(relais);
        } catch (Exception e) {
            // Aucun relais possible : ouvrir l'application plutot que de
            // laisser un ecran vide.
            Log.w(TAG, "relais vers le composeur systeme impossible", e);
            try {
                startActivity(new Intent(this, ca.erplibre.home.MainActivity.class));
            } catch (Exception ignored) {
                // On a fait ce qu'on pouvait ; fermer vaut mieux que planter.
            }
        }
        finish();
    }
}
