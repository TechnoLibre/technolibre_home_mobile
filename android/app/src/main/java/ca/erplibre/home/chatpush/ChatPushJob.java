package ca.erplibre.home.chatpush;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.util.Log;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The 15-minute run of the chat push, owned by the system so it outlives
 * the process and, persisted, a reboot. Each run resolves the level against
 * the power state, starts the permanent service when the level wants it and
 * none runs, then runs PushEngine.runDue: the poll of levels 2 (off wifi
 * and charger), 3 and 4, the Odoo-direct checks and the pending
 * unregisters. Level 5 cancels the job.
 *
 * The run blocks on the network, so it goes to a worker thread and ends
 * with jobFinished; the system holds a wakelock until then.
 */
public class ChatPushJob extends JobService {

    private static final String TAG = "ChatPushJob";

    /** Stable id beside the SMS watchdog (4821) and the note sync (4822): rescheduling makes no duplicate. */
    static final int JOB_ID = 4823;

    /** Android's floor for a periodic job. */
    static final long PERIOD_MS = 15 * 60 * 1000L;

    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor();

    /**
     * Aligns the job and the permanent service with the mirrored level:
     * level 5 cancels the job and stops the service; any other schedules
     * the job, and starts the service when the level wants it (stops it
     * otherwise). A running service is asked to re-read the level.
     */
    public static void apply(Context c) {
        PushLevelPolicy.Effective e = ChatPushRuntime.effective(c);
        if (e.mode == PushLevelPolicy.Mode.OFF) {
            cancel(c);
            RealtimeHost.stop(c);
            return;
        }
        schedule(c);
        if (e.permanentService) RealtimeHost.start(c);
        else RealtimeHost.stop(c);
    }

    static void schedule(Context c) {
        JobScheduler scheduler = c.getSystemService(JobScheduler.class);
        if (scheduler == null || scheduler.getPendingJob(JOB_ID) != null) return;
        JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(c, ChatPushJob.class))
                .setPeriodic(PERIOD_MS)
                .setPersisted(true)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .build();
        try {
            scheduler.schedule(job);
        } catch (IllegalArgumentException | IllegalStateException e) {
            // a full job quota loses the periodic run, not the permanent service
            Log.w(TAG, "job not scheduled: " + e.getClass().getSimpleName());
        }
    }

    static void cancel(Context c) {
        JobScheduler scheduler = c.getSystemService(JobScheduler.class);
        if (scheduler != null) scheduler.cancel(JOB_ID);
    }

    @Override
    public boolean onStartJob(final JobParameters params) {
        final Context c = getApplicationContext();
        WORKER.execute(() -> {
            try {
                run(c);
            } catch (RuntimeException e) {
                // the class only: a message may carry a URL
                Log.w(TAG, "run failed: " + e.getClass().getSimpleName());
            } finally {
                jobFinished(params, false);
            }
        });
        return true;
    }

    private static void run(Context c) {
        PushLevelPolicy.Effective e = ChatPushRuntime.effective(c);
        if (e.mode == PushLevelPolicy.Mode.OFF) {
            cancel(c);
            RealtimeHost.stop(c);
            return;
        }
        if (e.permanentService && !ChatPushRuntime.serviceRunning()) RealtimeHost.start(c);
        ChatPushRuntime.get(c).engine().runDue(e);
    }

    /** Nothing to resume: the next period runs again. */
    @Override
    public boolean onStopJob(JobParameters params) {
        return false;
    }
}
