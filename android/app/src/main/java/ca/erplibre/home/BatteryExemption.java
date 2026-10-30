package ca.erplibre.home;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

/**
 * Ce qui décide si un travail d'arrière-plan part à l'heure : la dispense
 * des optimisations de batterie et les alarmes exactes, lues ou demandées
 * en ouvrant le réglage système. Partagé par la passerelle SMS et les
 * notifications du clavardage.
 */
public final class BatteryExemption {

    private BatteryExemption() {}

    /** Vrai avant Android 6, où l'optimisation de batterie n'existe pas ; faux si l'état est illisible. */
    public static boolean ignoringBatteryOptimizations(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true;
        }
        try {
            android.os.PowerManager pm = context.getSystemService(android.os.PowerManager.class);
            return pm != null && pm.isIgnoringBatteryOptimizations(context.getPackageName());
        } catch (Exception e) {
            return false;
        }
    }

    /** Vrai avant Android 12, où la permission n'existe pas ; faux si l'état est illisible. */
    public static boolean canScheduleExact(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return true;
        }
        try {
            android.app.AlarmManager am = context.getSystemService(android.app.AlarmManager.class);
            return am != null && am.canScheduleExactAlarms();
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Ouvre la liste système des dispenses d'optimisation de batterie, où
     * l'utilisateur choisit lui-même l'app. La passerelle SMS passe par
     * elle ; le clavardage demande la dispense directement
     * (requestExemption), ce que la politique de Google Play admet pour une
     * messagerie en temps réel qui ne peut pas passer par FCM : la
     * justification est dans doc/GOOGLE_PLAY. Lève l'exception de
     * startActivity quand le réglage est introuvable.
     */
    public static void openBatterySettings(Context context) {
        Intent intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }

    /**
     * Demande la dispense par la boîte de dialogue système
     * (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` sur `package:<id>`,
     * permission déclarée au manifeste) ; un appareil qui n'a pas cette
     * boîte reçoit la liste (openBatterySettings). Rend la main dès que
     * l'écran s'ouvre : la réponse se lit ensuite par
     * ignoringBatteryOptimizations. Lève l'exception de startActivity
     * quand la liste est introuvable aussi.
     */
    public static void requestExemption(Context context) {
        Intent intent = new Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:" + context.getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
        } catch (ActivityNotFoundException e) {
            openBatterySettings(context);
        }
    }

    /**
     * Ouvre le réglage des alarmes exactes (Android 12+). Sans elles,
     * `setExactAndAllowWhileIdle` devient `setAndAllowWhileIdle` et les
     * réveils se regroupent. Lève l'exception de startActivity quand le
     * réglage est introuvable.
     */
    public static void openExactAlarmSettings(Context context) {
        Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }
}
