package ca.erplibre.home.chatpush;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import androidx.core.app.RemoteInput;
import java.util.Map;
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
 *   network call; a blank reply records nothing. When the runtime cannot
 *   be built or the record cannot be sealed, the action is not dropped
 *   silently: the conversation is re-posted as it is (a reply field stops
 *   waiting) and the server's « Action non envoyée » notification is
 *   posted, without the reply text;
 * - ChatActionJob scheduled as a safety net, so an action whose run dies
 *   with the process is turned back and run later;
 * - the notification updated at once: a reply appended as the user's own
 *   message, mark read and mute cancel it, 👍 drops its button;
 * - one run of the action (8 s per Odoo call); a retry schedules
 *   ChatActionJob for its nextAt, a handoff redraws the server's handoff
 *   notification, and the runtime's actions listener is told. A reply
 *   that ended lets the replies typed after it in its conversation run at
 *   once (ActionRunner.runFollowing): replies reach Odoo in typing order.
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
        ChatPushRuntime runtime = null;
        ChatAction a;
        try {
            runtime = ChatPushRuntime.get(c);
            if (p.kind == ActionKind.REPLY && text.trim().isEmpty()) {
                // nothing to send; the re-post ends the reply field's progress state
                runtime.notifier().refresh(p.tag);
                return;
            }
            a = runtime.actionStore().add(p.configId, p.kind, p.channelId, p.messageId, p.atMostS, text);
        } catch (RuntimeException e) {
            // the class only: a message may carry a URL
            Log.w(TAG, "action not recorded: " + e.getClass().getSimpleName());
            unsent(c, runtime, p);
            return;
        }
        ChatNotifier notifier = runtime.notifier();
        ActionStore store = runtime.actionStore();
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
        if (p.kind == ActionKind.REPLY) {
            for (Map.Entry<String, ActionRunner.Outcome> e : runtime.runner().runFollowing(a).entrySet()) {
                runtime.afterRun(e.getKey(), e.getValue());
            }
        }
        ChatActionJob.sync(c, store);
    }

    /**
     * The action could not be recorded: its conversation re-posted as it is
     * and the server's « Action non envoyée » notification posted. Without a
     * runtime, a notifier over the settings file alone draws them (it needs
     * no Keystore key).
     */
    private static void unsent(Context c, ChatPushRuntime runtime, ChatActionIntent.Parsed p) {
        try {
            ChatNotifier notifier = runtime != null ? runtime.notifier()
                    : new ChatNotifier(c, new PushSettingsStore(new PrefsKeyValue(c, ChatPushRuntime.SETTINGS_FILE)));
            notifier.refresh(p.tag);
            notifier.unsent(p.configId);
        } catch (RuntimeException e) {
            Log.w(TAG, "unsent notice failed: " + e.getClass().getSimpleName());
        }
    }
}
