package ca.erplibre.home.chatpush;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.util.Log;

/**
 * The way down from a climbed level: a one-off job that waits for the
 * phone to be plugged in, then re-applies the level (ChatPushJob.apply),
 * which brings the permanent service back when the chosen level wants it.
 * Without it, plugging in would wait for the next 15-minute run. It is
 * pending exactly while the level is climbed and the phone is not really
 * plugged in (wanted); ChatPushJob and the permanent service align it at
 * each re-read through sync.
 *
 * Not persisted: after a reboot, ChatPushBootReceiver re-applies the level,
 * which schedules it again when still wanted.
 */
public class ChatClimbJob extends JobService {

    private static final String TAG = "ChatClimbJob";

    /** Stable id after ChatPushJob (4823) and ChatActionJob (4824). */
    static final int JOB_ID = 4825;

    /**
     * Whether the job should be pending: the level is climbed and the phone
     * is not plugged in. realPlugged is the battery's own state, never the
     * test door's: JobScheduler sees the real charger, and a job it runs at
     * once would be scheduled again at once.
     */
    static boolean wanted(PushLevelPolicy.Effective e, boolean realPlugged) {
        return !e.climbReason.isEmpty() && !realPlugged;
    }

    /** Schedules the job when wanted and none is pending, cancels it otherwise. */
    static void sync(Context c, PushLevelPolicy.Effective e, boolean realPlugged) {
        JobScheduler scheduler = c.getSystemService(JobScheduler.class);
        if (scheduler == null) return;
        if (!wanted(e, realPlugged)) {
            scheduler.cancel(JOB_ID);
            return;
        }
        if (scheduler.getPendingJob(JOB_ID) != null) return;
        JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(c, ChatClimbJob.class))
                .setRequiresCharging(true)
                .build();
        try {
            scheduler.schedule(job);
        } catch (IllegalArgumentException | IllegalStateException ex) {
            // a full job quota leaves the way down to the 15-minute run
            Log.w(TAG, "job not scheduled: " + ex.getClass().getSimpleName());
        }
    }

    /** Re-applies the level on the main thread: it reads local files and starts or asks the service. */
    @Override
    public boolean onStartJob(JobParameters params) {
        try {
            ChatPushJob.apply(getApplicationContext());
        } catch (RuntimeException e) {
            Log.w(TAG, "level not applied: " + e.getClass().getSimpleName());
        }
        return false;
    }

    /** Nothing to resume: apply ran to its end inside onStartJob. */
    @Override
    public boolean onStopJob(JobParameters params) {
        return false;
    }
}
