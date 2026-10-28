package ca.erplibre.home;

import android.content.Context;
import android.content.Intent;
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
     * Ouvre la liste système des dispenses d'optimisation de batterie.
     *
     * <p>La dispense n'est PAS demandée par une boîte de dialogue directe
     * (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) : Google la réserve à
     * des cas précis et la refuse à la publication. La liste, où
     * l'utilisateur choisit lui-même, est le chemin que le système accepte
     * durablement. Lève l'exception de startActivity quand le réglage est
     * introuvable.
     */
    public static void openBatterySettings(Context context) {
        Intent intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
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
