package ca.erplibre.home;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.getcapacitor.JSObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Android Foreground Service for downloading Whisper GGML model files.
 *
 * Runs with a persistent notification so Android does not kill the download
 * when the screen turns off or the app is sent to the background.
 *
 * The notification includes an "Annuler" action that stops the service and
 * keeps the .partial file for a future Range-based resume.
 *
 * Communication back to the JS layer uses the static WhisperPlugin.instance
 * reference (notifyListeners is thread-safe in Capacitor) and the
 * onForegroundDownload* callbacks which dispatch onto the UI thread.
 */
public class WhisperDownloadService extends Service {

    static final String TAG        = "WhisperDownloadService";
    static final String CHANNEL_ID = "whisper_download";
    static final int    NOTIF_ID   = 9001;

    static final String EXTRA_MODEL   = "model";
    static final String EXTRA_URL     = "url";
    static final String ACTION_CANCEL = "ca.erplibre.home.CANCEL_DOWNLOAD";

    private volatile boolean cancelRequested = false;

    /** True while a download thread is running — prevents duplicate threads. */
    static volatile boolean downloading  = false;
    /** Model currently being downloaded, or null when idle. */
    static volatile String  currentModel = null;

    // ─────────────────────────────────────────────────────────────────────────

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Handle cancel intent (from notification button or cancelDownload())
        if (ACTION_CANCEL.equals(intent != null ? intent.getAction() : null)) {
            Log.i(TAG, "Cancel requested via intent");
            cancelRequested = true;
            stopSelf();
            return START_NOT_STICKY;
        }

        String model  = intent != null ? intent.getStringExtra(EXTRA_MODEL) : null;
        String urlStr = intent != null ? intent.getStringExtra(EXTRA_URL)   : null;

        if (model == null || urlStr == null) {
            Log.w(TAG, "Missing model or url, stopping");
            stopSelf();
            return START_NOT_STICKY;
        }

        // Guard: onStartCommand is called again when downloadModelForeground()
        // is invoked while the service is already running (e.g. after Activity
        // recreation). Do NOT start a second download thread — the existing one
        // will complete and call back via the updated pendingForegroundCallId.
        if (downloading) {
            Log.i(TAG, "[FG] Already downloading '" + currentModel + "', ignoring duplicate start");
            return START_NOT_STICKY;
        }

        cancelRequested = false;
        currentModel    = model;
        downloading     = true;

        // Show initial notification before doing any work
        startForeground(NOTIF_ID, buildNotification(model, 0, false));

        final String m = model;
        final String u = urlStr;
        new Thread(() -> performDownload(m, u)).start();

        return START_NOT_STICKY;
    }

    // ─── Download logic ───────────────────────────────────────────────────────

    private void performDownload(String model, String urlStr) {
        File dest    = modelFile(model);
        File partial = partialFile(model);
        dest.getParentFile().mkdirs();

        long resumeFrom = partial.exists() ? partial.length() : 0;
        boolean appending = resumeFrom > 0;
        if (appending) {
            Log.i(TAG, "[FG] Resuming " + model + " from byte " + resumeFrom);
        }

        HttpURLConnection conn = null;
        long  resumeBytes = resumeFrom;
        boolean doAppend  = appending;

        try {
            URL url = new URL(urlStr);

            for (int hop = 0; hop < 5; hop++) {
                conn = (HttpURLConnection) url.openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(30_000);
                conn.setReadTimeout(60_000);
                if (resumeBytes > 0) {
                    conn.setRequestProperty("Range", "bytes=" + resumeBytes + "-");
                }
                conn.connect();
                int status = conn.getResponseCode();

                if (status == HttpURLConnection.HTTP_MOVED_PERM
                        || status == HttpURLConnection.HTTP_MOVED_TEMP
                        || status == 307 || status == 308) {
                    String loc = conn.getHeaderField("Location");
                    conn.disconnect();
                    conn        = null;
                    url         = new URL(loc);
                    resumeBytes = 0;
                    doAppend    = false;
                    continue;
                }

                if (status != HttpURLConnection.HTTP_PARTIAL) {
                    resumeBytes = 0;
                    doAppend    = false;
                    if (partial.exists()) partial.delete();
                }
                break;
            }

            if (conn == null) {
                notifyError(model, "Too many redirects");
                return;
            }

            long serverContent = conn.getContentLengthLong();
            long total = serverContent > 0 ? resumeBytes + serverContent : 0;

            try (InputStream      in  = conn.getInputStream();
                 FileOutputStream  out = new FileOutputStream(partial, doAppend)) {

                byte[] buf    = new byte[64 * 1024];
                long received = resumeBytes;
                int  n;

                while (!cancelRequested && (n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                    received += n;

                    int percent = total > 0 ? (int) (received * 100 / total) : 0;
                    updateNotification(model, percent);
                    forwardProgress(received, total);
                }
            }

            if (cancelRequested) {
                Log.i(TAG, "[FG] Download of " + model + " cancelled — partial kept");
                notifyCancelled(model);
                return;
            }

            // Rename .partial → .bin
            if (!partial.renameTo(dest)) {
                try (InputStream     in  = new FileInputStream(partial);
                     FileOutputStream out = new FileOutputStream(dest)) {
                    byte[] buf = new byte[64 * 1024];
                    int    n;
                    while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                }
                partial.delete();
            }

            Log.i(TAG, "[FG] Download complete: " + dest.getAbsolutePath());
            notifyComplete(dest.getAbsolutePath());

        } catch (Exception e) {
            Log.e(TAG, "[FG] Download failed", e);
            notifyError(model, e.getMessage());
        } finally {
            downloading  = false;
            currentModel = null;
            if (conn != null) conn.disconnect();
            stopSelf();
        }
    }

    // ─── Plugin callbacks ─────────────────────────────────────────────────────

    private void forwardProgress(long received, long total) {
        WhisperPlugin plugin = WhisperPlugin.instance;
        if (plugin == null) return;
        double ratio = total > 0 ? (double) received / total : 0.0;
        JSObject evt = new JSObject();
        evt.put("ratio",    ratio);
        evt.put("received", received);
        evt.put("total",    total);
        plugin.notifyDownloadProgress(evt);
    }

    private void notifyComplete(String path) {
        WhisperPlugin plugin = WhisperPlugin.instance;
        if (plugin != null) plugin.onForegroundDownloadComplete(path);
    }

    private void notifyError(String model, String message) {
        WhisperPlugin plugin = WhisperPlugin.instance;
        if (plugin != null) plugin.onForegroundDownloadError(message);
        stopSelf();
    }

    private void notifyCancelled(String model) {
        WhisperPlugin plugin = WhisperPlugin.instance;
        if (plugin != null) plugin.onForegroundDownloadCancelled();
    }

    // ─── Notification ─────────────────────────────────────────────────────────

    private void updateNotification(String model, int percent) {
        NotificationManager nm = (NotificationManager)
            getSystemService(NOTIFICATION_SERVICE);
        nm.notify(NOTIF_ID, buildNotification(model, percent, false));
    }

    private Notification buildNotification(String model, int percent, boolean indeterminate) {
        // "Annuler" action: sends ACTION_CANCEL back to this service
        Intent cancelIntent = new Intent(this, WhisperDownloadService.class);
        cancelIntent.setAction(ACTION_CANCEL);
        PendingIntent cancelPI = PendingIntent.getService(
            this, 0, cancelIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Téléchargement Whisper — " + model)
            .setContentText(indeterminate ? "Démarrage…" : percent + " %")
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setProgress(100, percent, indeterminate)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Annuler", cancelPI)
            .setOngoing(true)
            .setSilent(true)
            .build();
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private File modelFile(String model) {
        return new File(getFilesDir(), "whisper/ggml-" + model + ".bin");
    }

    private File partialFile(String model) {
        return new File(getFilesDir(), "whisper/ggml-" + model + ".partial");
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null; // not a bound service
    }

    @Override
    public void onDestroy() {
        cancelRequested = true;
        super.onDestroy();
    }
}
