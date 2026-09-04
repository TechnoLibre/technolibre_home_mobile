package ca.erplibre.home.phone;

import android.app.Activity;
import android.app.role.RoleManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.telecom.TelecomManager;

/**
 * Prise et restitution du role de composeur par defaut.
 *
 * <p>REVERSIBLE PAR CONSTRUCTION, et c'est la condition pour que cette sonde
 * soit acceptable : le role se rend depuis l'application, et de toute facon
 * depuis Reglages > Applications par defaut > Application Telephone. Le
 * systeme ne laisse jamais une application s'emparer du role sans un dialogue
 * explicite, ni empecher l'utilisatrice de le reprendre.
 */
public final class CallRole {

    private CallRole() {
    }

    /** L'application tient-elle le role de composeur ? */
    public static boolean detenu(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            RoleManager rm = context.getSystemService(RoleManager.class);
            return rm != null
                    && rm.isRoleAvailable(RoleManager.ROLE_DIALER)
                    && rm.isRoleHeld(RoleManager.ROLE_DIALER);
        }
        TelecomManager tm = context.getSystemService(TelecomManager.class);
        return tm != null
                && context.getPackageName().equals(tm.getDefaultDialerPackage());
    }

    /** Ouvre le dialogue systeme qui propose de nous confier le role. */
    public static Intent intentDemande(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            RoleManager rm = context.getSystemService(RoleManager.class);
            if (rm != null && rm.isRoleAvailable(RoleManager.ROLE_DIALER)) {
                return rm.createRequestRoleIntent(RoleManager.ROLE_DIALER);
            }
            return null;
        }
        Intent i = new Intent(TelecomManager.ACTION_CHANGE_DEFAULT_DIALER);
        i.putExtra(TelecomManager.EXTRA_CHANGE_DEFAULT_DIALER_PACKAGE_NAME,
                context.getPackageName());
        return i;
    }

    /**
     * Rend le role, en ouvrant l'ecran des applications par defaut.
     *
     * <p>Il n'existe pas d'API pour se retirer soi-meme un role : c'est voulu,
     * une application ne doit pas pouvoir manipuler ces choix sans que
     * l'utilisatrice voie ce qui se passe. On la conduit donc au bon ecran.
     */
    public static Intent intentRestitution() {
        Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return i;
    }

    /**
     * Compose un numero, en tant que composeur par defaut.
     *
     * <p>On passe par {@link TelecomManager#placeCall} et non par une activite
     * {@code ACTION_CALL} : depuis l'API 29, Android supprime silencieusement
     * les lancements d'activite en arriere-plan, et un service au premier plan
     * ne leve pas cette interdiction. C'est la lecon d'une panne deja
     * diagnostiquee dans ce depot — des appels restes bloques en composition
     * sans le moindre message.
     *
     * @return vrai si la demande a ete transmise a Telecom
     */
    public static boolean composer(Context context, String numero) {
        if (numero == null || numero.trim().isEmpty()) {
            return false;
        }
        TelecomManager tm = context.getSystemService(TelecomManager.class);
        if (tm == null) {
            return false;
        }
        try {
            tm.placeCall(
                    android.net.Uri.fromParts("tel", numero.trim(), null),
                    new android.os.Bundle());
            return true;
        } catch (SecurityException | IllegalStateException e) {
            android.util.Log.w("CallRole", "composition refusee", e);
            return false;
        }
    }

    public static void demander(Activity activite, int codeRetour) {
        Intent i = intentDemande(activite);
        if (i != null) {
            activite.startActivityForResult(i, codeRetour);
        }
    }
}
