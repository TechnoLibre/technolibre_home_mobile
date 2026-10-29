package ca.erplibre.home.chatpush;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import androidx.core.app.RemoteInput;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * A notification button pressed (ChatActionIntent). Not exported: only this
 * app's PendingIntents reach it. The main thread only parses the broadcast
 * and reads the reply text, then goAsync() hands the rest to a worker
 * thread of its own, in this order:
 * - the action recorded in the process's ActionStore, durably, before any
 *   network call; a blank reply records nothing;
 * - ChatActionJob scheduled as a safety net, so an action whose run dies
 *   with the process is turned back and run later;
 * - the notification updated at once: a reply appended as the user's own
 *   message, mark read and mute cancel it, 👍 drops its button;
 * - one run of the action (8 s per Odoo call); a retry schedules
 *   ChatActionJob for its nextAt, a handoff redraws the server's handoff
 *   notification, and the runtime's actions listener is told.
 * The broadcast is finished after the run or after FINISH_MS, whichever
 * comes first, within Android's 10 s; a run still going then keeps its
 * record RUNNING and ends on its own. Nothing here logs the reply text,
 * the target or a URL.
 */
public class ChatActionReceiver extends BroadcastReceiver {

    private static final String TAG = "ChatActionReceiver";

    /** The broadcast is finished at the latest after this, inside Android's 10 s. */
    static final long FINISH_MS = 9_000L;

    /** One thread per broadcast: a run waiting on Odoo never holds back the recording of the next action. */
    private static final ExecutorService WORKER = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "chat-action");
        t.setDaemon(true);
        return t;
    });
    private static final ScheduledExecutorService TIMER = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "chat-action-timer");
        t.setDaemon(true);
        return t;
    });

    @Override
    public void onReceive(Context context, Intent intent) {
        final ChatActionIntent.Parsed p = ChatActionIntent.parse(intent);
        if (p == null) return;
        String reply = "";
        if (p.kind == ActionKind.REPLY) {
            Bundle results = RemoteInput.getResultsFromIntent(intent);
            CharSequence typed = results == null ? null : results.getCharSequence(ChatActionIntent.KEY_REPLY);
            reply = typed == null ? "" : typed.toString();
        }
        final String text = reply;
        final Context c = context.getApplicationContext();
        final PendingResult result = goAsync();
        final AtomicBoolean finished = new AtomicBoolean();
        final Runnable finish = () -> {
            if (finished.compareAndSet(false, true)) result.finish();
        };
        TIMER.schedule(finish, FINISH_MS, TimeUnit.MILLISECONDS);
        WORKER.execute(() -> {
            try {
                handle(c, p, text);
            } catch (RuntimeException e) {
                // the class only: a message may carry a URL
                Log.w(TAG, "action failed: " + e.getClass().getSimpleName());
            } finally {
                finish.run();
            }
        });
    }

    private static void handle(Context c, ChatActionIntent.Parsed p, String text) {
        ChatPushRuntime runtime = ChatPushRuntime.get(c);
        ChatNotifier notifier = runtime.notifier();
        if (p.kind == ActionKind.REPLY && text.trim().isEmpty()) {
            // nothing to send; the re-post ends the reply field's progress state
            notifier.appendOwnReply(p.tag, "");
            return;
        }
        ActionStore store = runtime.actionStore();
        ChatAction a = store.add(p.configId, p.kind, p.channelId, p.messageId, p.atMostS, text);
        ChatActionJob.schedule(c, System.currentTimeMillis() + ActionStore.FIRST_RETRY_MS);
        switch (p.kind) {
            case REPLY:
                notifier.appendOwnReply(p.tag, text);
                break;
            case REACT:
                notifier.withoutReact(p.tag);
                break;
            default:
                notifier.cancel(p.tag);
                break;
        }
        ActionRunner.Outcome o = runtime.runner().run(a.id);
        runtime.afterRun(a.id, o);
        ChatActionJob.sync(c, store);
    }
}
