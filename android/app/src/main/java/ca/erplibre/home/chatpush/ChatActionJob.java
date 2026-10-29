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
 * The retry of the notification actions, owned by the system so it
 * outlives the process and, persisted, a reboot: one one-off job, due when
 * the earliest PENDING action is (ActionStore.wakeAt), on any network. A
 * run turns back the RUNNING actions of a dead process, runs the due ones
 * on a worker thread, then schedules itself again while actions remain.
 * It runs whatever the push level: the actions are the user's, not the
 * poll's.
 *
 * Scheduling the job's own id stops a run of it in progress, so a run
 * schedules the next one only after jobFinished.
 */
public class ChatActionJob extends JobService {

    private static final String TAG = "ChatActionJob";

    /** Stable id beside the SMS watchdog (4821), the note sync (4822) and the chat push (4823). */
    static final int JOB_ID = 4824;

    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor();

    /** Schedules the job at `at` (epoch ms; now when past), replacing the one scheduled. */
    static void schedule(Context c, long at) {
        JobScheduler scheduler = c.getSystemService(JobScheduler.class);
        if (scheduler == null) return;
        JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(c, ChatActionJob.class))
                .setMinimumLatency(Math.max(0L, at - System.currentTimeMillis()))
                .setPersisted(true)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .build();
        try {
            scheduler.schedule(job);
        } catch (IllegalArgumentException | IllegalStateException e) {
            // a full job quota leaves the retry to the next chat push job run
            Log.w(TAG, "job not scheduled: " + e.getClass().getSimpleName());
        }
    }

    /** Schedules the job for the store's next work, or cancels it when there is none. */
    static void sync(Context c, ActionStore store) {
        long at = store.wakeAt();
        if (at > 0) {
            schedule(c, at);
            return;
        }
        JobScheduler scheduler = c.getSystemService(JobScheduler.class);
        if (scheduler != null) scheduler.cancel(JOB_ID);
    }

    @Override
    public boolean onStartJob(final JobParameters params) {
        final Context c = getApplicationContext();
        WORKER.execute(() -> {
            ChatPushRuntime runtime = null;
            try {
                runtime = ChatPushRuntime.get(c);
                runtime.runActions();
            } catch (RuntimeException e) {
                // the class only: a message may carry a URL
                Log.w(TAG, "run failed: " + e.getClass().getSimpleName());
            } finally {
                jobFinished(params, false);
            }
            if (runtime != null) {
                try {
                    sync(c, runtime.actionStore());
                } catch (RuntimeException e) {
                    Log.w(TAG, "reschedule failed: " + e.getClass().getSimpleName());
                }
            }
        });
        return true;
    }

    /** The worker goes on; recover() and the next run pick up what it leaves. */
    @Override
    public boolean onStopJob(JobParameters params) {
        return false;
    }
}
