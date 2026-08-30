package ca.erplibre.home;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.util.Log;

/**
 * Surveille la passerelle et la relance quand elle est tombee.
 *
 * <p>Le service porte deja une alarme qui cadence ses cycles — mais cette
 * alarme vit DANS le service : quand Android le tue, elle meurt avec lui, et
 * plus rien ne remarque le silence. C'est precisement le cas observe apres une
 * reinstallation, ou l'ecran annoncait une passerelle en service alors
 * qu'aucun processus ne tournait.
 *
 * <p>Un travail planifie appartient au systeme, pas a l'application : il
 * survit a la mort du processus, et c'est la seule raison de l'utiliser ici.
 * Il est PERSISTE, donc il traverse aussi les redemarrages du telephone.
 *
 * <p>Quinze minutes est le plancher impose par Android pour un travail
 * periodique. C'est grossier pour un canal d'alerte, et c'est assume : ce
 * filet ne remplace pas le cadencement du service, il rattrape sa mort.
 */
public class SmsWatchdogJob extends JobService {

    private static final String TAG = "SmsWatchdog";

    /** Identifiant stable : replanifier ne cree pas de doublon. */
    private static final int JOB_ID = 4821;

    /** Plancher d'Android pour un travail periodique. */
    private static final long PERIOD_MS = 15 * 60 * 1000L;

    /** Installe la surveillance. Sans effet si elle est deja en place. */
    public static void schedule(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler == null) {
            return;
        }
        if (scheduler.getPendingJob(JOB_ID) != null) {
            return;
        }
        JobInfo job = new JobInfo.Builder(
                JOB_ID, new ComponentName(context, SmsWatchdogJob.class))
                .setPeriodic(PERIOD_MS)
                .setPersisted(true)
                .build();
        try {
            scheduler.schedule(job);
            Log.i(TAG, "Surveillance planifiee");
        } catch (IllegalArgumentException | IllegalStateException e) {
            // Un quota de travaux atteint ne doit pas empecher la passerelle
            // de demarrer : on perd le filet, pas le service.
            Log.w(TAG, "Surveillance impossible a planifier", e);
        }
    }

    /** Retire la surveillance. Appelee quand la passerelle est arretee. */
    public static void cancel(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler != null) {
            scheduler.cancel(JOB_ID);
        }
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        SmsGatewayConfig config = new SmsGatewayConfig(this);
        SmsJournal journal = new SmsJournal(this);

        if (!config.isEnabled() || !config.isConfigured()) {
            // La passerelle a ete arretee volontairement : le filet n'a plus
            // de raison d'etre, et le laisser tourner reveillerait l'appareil
            // toutes les quinze minutes pour rien.
            journal.info(SmsJournal.CAT_SERVICE,
                    "Surveillance retiree : passerelle arretee", null);
            cancel(this);
            return false;
        }

        if (SmsGatewayService.running) {
            // Rien a dire. On ne journalise PAS les controles sans incident :
            // a quatre-vingt-seize reveils par jour, ils noieraient les vraies
            // relances qu'on cherche a retrouver.
            return false;
        }

        journal.warn(SmsJournal.CAT_SERVICE,
                "Surveillance : passerelle activee mais service absent,"
                        + " relance automatique", null);
        SmsGatewayService.start(this);
        return false;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        // Rien a reprendre : la relance est immediate ou elle n'a pas eu lieu,
        // et le prochain reveil reessaiera de toute facon.
        return false;
    }
}
