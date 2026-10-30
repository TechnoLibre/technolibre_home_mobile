package ca.erplibre.home.chatpush;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationCompat;
import androidx.core.app.RemoteInput;

/**
 * The test door of the chat notifications, packaged only in the -PsyncTest build (src/synctest/). Its
 * manifest entry requires android.permission.DUMP, which the adb shell holds and no app does: ERPLibre's
 * device scenarios fire a notification's actions through it without touching the notification shade.
 *
 * <p>An ordered broadcast (am broadcast) with the extras tag, kind (reply, read, mute, react, open) and,
 * for reply, text: the app's own active notification posted under tag is looked up, and the real
 * PendingIntent the user's tap would send is sent — the action button TestDoorChoice picks (for reply,
 * with the text filled in as its RemoteInput result) or the content intent for open. The result data
 * says what happened ("sent", or the reason nothing was sent); nothing else is done and nothing is
 * logged.
 */
public final class ChatTestDoor extends BroadcastReceiver {

    static final String ACTION = "ca.erplibre.home.chatpush.TEST_DOOR";
    static final String EXTRA_TAG = "tag";
    static final String EXTRA_KIND = "kind";
    static final String EXTRA_TEXT = "text";

    @Override
    public void onReceive(Context context, Intent intent) {
        setResultData(fire(context, intent));
    }

    private static String fire(Context context, Intent intent) {
        if (intent == null || !ACTION.equals(intent.getAction())) return "refused";
        String tag = intent.getStringExtra(EXTRA_TAG);
        String kind = intent.getStringExtra(EXTRA_KIND);
        if (tag == null || kind == null) return "refused";
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return "no-notification";
        Notification n = null;
        int found = 0;
        for (StatusBarNotification s : manager.getActiveNotifications()) {
            if (tag.equals(s.getTag())) {
                n = s.getNotification();
                found++;
            }
        }
        if (found != 1) return found == 0 ? "no-notification" : "ambiguous";
        int count = NotificationCompat.getActionCount(n);
        int[] semantics = new int[count];
        for (int i = 0; i < count; i++) {
            NotificationCompat.Action a = NotificationCompat.getAction(n, i);
            semantics[i] = a == null ? NotificationCompat.Action.SEMANTIC_ACTION_NONE : a.getSemanticAction();
        }
        int pick = TestDoorChoice.pick(kind, semantics);
        try {
            if (pick == TestDoorChoice.OPEN) {
                if (n.contentIntent == null) return "no-action";
                n.contentIntent.send();
                return "sent";
            }
            if (pick == TestDoorChoice.NONE) return "no-action";
            NotificationCompat.Action action = NotificationCompat.getAction(n, pick);
            PendingIntent pending = action.getActionIntent();
            if (pending == null) return "no-action";
            if (!"reply".equals(kind)) {
                pending.send();
                return "sent";
            }
            RemoteInput[] inputs = action.getRemoteInputs();
            String text = intent.getStringExtra(EXTRA_TEXT);
            if (inputs == null || inputs.length != 1 || text == null || text.isEmpty()) return "no-reply-input";
            Intent fillIn = new Intent();
            Bundle results = new Bundle();
            results.putCharSequence(inputs[0].getResultKey(), text);
            RemoteInput.addResultsToIntent(inputs, fillIn, results);
            pending.send(context, 0, fillIn);
            return "sent";
        } catch (PendingIntent.CanceledException e) {
            return "canceled";
        }
    }
}
