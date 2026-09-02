package ca.erplibre.home;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Relance la passerelle après un redémarrage du téléphone ou une mise à jour
 * de l'application.
 *
 * <p>Sans ce récepteur, une coupure de courant au studio suffirait à éteindre le
 * canal d'alerte définitivement : le téléphone redémarrerait, l'application ne
 * serait pas ouverte, et rien ne l'indiquerait côté Odoo avant l'expiration du
 * signal de vie.
 *
 * <p>{@code ACTION_MY_PACKAGE_REPLACED} est traité aussi, parce qu'installer un
 * nouvel APK arrête le service sans le relancer.
 */
public class SmsBootReceiver extends BroadcastReceiver {

    private static final String TAG = "SmsBootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) {
            return;
        }
        boolean relevant = Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action);
        if (!relevant) {
            return;
        }

        SmsGatewayConfig config = new SmsGatewayConfig(context);
        if (!config.isEnabled() || !config.isConfigured()) {
            Log.i(TAG, "Passerelle non activée, aucun démarrage après " + action);
            return;
        }
        Log.i(TAG, "Relance de la passerelle après " + action);
        new SmsJournal(context).info(SmsJournal.CAT_SERVICE,
                "Relance apres " + action, null);
        SmsGatewayService.start(context);
        // Le filet n'est pas persiste sur tous les appareils apres une mise a
        // jour de l'application : on le repose sans condition, la planification
        // est sans effet s'il est deja la.
        SmsWatchdogJob.schedule(context);
    }
}
