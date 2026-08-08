package ca.erplibre.home;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

/**
 * File d'attente PERSISTANTE de la passerelle SMS.
 *
 * <p>Ceci n'est pas un cache : c'est le chemin critique. Une file en mémoire
 * (LinkedBlockingQueue) perdrait silencieusement des messages, parce que
 * l'identifiant du dernier événement ntfy consommé est persisté : après une mort
 * du processus, la reprise {@code ?since=<lastId>} sauterait un message qui
 * n'était plus que dans la file volatile. Le SMS ne partirait jamais et personne
 * ne le saurait.
 *
 * <p>Règle d'ordre invariante, respectée par {@link SmsGatewayService} :
 * on insère ici D'ABORD, on avance l'identifiant ntfy ENSUITE.
 */
public class SmsOutbox extends SQLiteOpenHelper {

    private static final String TAG = "SmsOutbox";
    private static final String DB_NAME = "erplibre_sms.db";
    /** 2 : ajout de la table {@code event}, journal local de la passerelle. */
    private static final int DB_VERSION = 2;

    public static final String STATE_PENDING = "pending";
    public static final String STATE_SENDING = "sending";
    public static final String STATE_SUBMITTED = "submitted";
    public static final String STATE_DELIVERED = "delivered";
    public static final String STATE_FAILED = "failed";

    /** Nombre de tentatives avant abandon définitif. */
    public static final int MAX_ATTEMPTS = 4;
    /** Recul entre tentatives, en millisecondes. */
    public static final long[] BACKOFF_MS = {30_000L, 120_000L, 600_000L, 1_800_000L};

    private static SmsOutbox instance;

    public static synchronized SmsOutbox get(Context context) {
        if (instance == null) {
            instance = new SmsOutbox(context.getApplicationContext());
        }
        return instance;
    }

    private SmsOutbox(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE outbox ("
                + "sms_uuid TEXT PRIMARY KEY,"
                + "job_id TEXT NOT NULL,"
                + "number TEXT NOT NULL,"
                + "body TEXT NOT NULL,"
                + "segments INTEGER NOT NULL DEFAULT 1,"
                + "state TEXT NOT NULL DEFAULT 'pending',"
                + "attempts INTEGER NOT NULL DEFAULT 0,"
                + "seq INTEGER NOT NULL DEFAULT 0,"
                + "created_at INTEGER NOT NULL,"
                + "expires_at INTEGER NOT NULL,"
                + "next_attempt_at INTEGER NOT NULL DEFAULT 0,"
                + "segments_ok INTEGER NOT NULL DEFAULT 0,"
                + "segments_failed INTEGER NOT NULL DEFAULT 0,"
                + "last_code TEXT,"
                + "last_error TEXT)");
        db.execSQL("CREATE INDEX idx_outbox_state ON outbox(state, next_attempt_at)");

        // Un enregistrement par segment envoyé : c'est ce qui permet de faire
        // correspondre un accusé de réception à son message. Le code de requête
        // du PendingIntent est la clé, et il est global et monotone.
        db.execSQL("CREATE TABLE segment ("
                + "request_code INTEGER PRIMARY KEY,"
                + "sms_uuid TEXT NOT NULL,"
                + "seg_index INTEGER NOT NULL,"
                + "created_at INTEGER NOT NULL)");
        db.execSQL("CREATE INDEX idx_segment_uuid ON segment(sms_uuid)");

        // Horodatage de chaque segment réellement remis à SmsManager.
        // Persisté parce que le compteur d'Android est PAR PAQUET et survit à la
        // mort de notre processus : un compteur en mémoire nous ferait dépasser
        // la limite juste après un redémarrage.
        db.execSQL("CREATE TABLE rate_log (sent_at INTEGER NOT NULL)");
        db.execSQL("CREATE INDEX idx_rate_log ON rate_log(sent_at)");

        // Rapports en attente d'acheminement vers Odoo.
        db.execSQL("CREATE TABLE spool ("
                + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                + "endpoint TEXT NOT NULL,"
                + "payload TEXT NOT NULL,"
                + "created_at INTEGER NOT NULL,"
                + "attempts INTEGER NOT NULL DEFAULT 0)");

        // SMS entrants, en attente de remontée.
        db.execSQL("CREATE TABLE inbound ("
                + "id TEXT PRIMARY KEY,"
                + "number TEXT NOT NULL,"
                + "body TEXT NOT NULL,"
                + "received_at INTEGER NOT NULL,"
                + "reported INTEGER NOT NULL DEFAULT 0)");

        createEventTable(db);
    }

    /**
     * Journal local de la passerelle — voir {@link SmsJournal}.
     *
     * <p>Odoo garde la vue métier des envois ; cette table garde ce que seul
     * l'appareil sait : permission retirée, SIM absente, réseau coupé, cycle
     * non déclenché. L'écran n'affichait que l'état courant, qui disparaît au
     * bout de trente secondes.
     *
     * <p>{@code detail} ne reçoit le corps des messages que si l'exploitant a
     * élevé le niveau de journalisation ; par défaut il reste vide.
     */
    static void createEventTable(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE event ("
                + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                + "at INTEGER NOT NULL,"
                + "level TEXT NOT NULL,"
                + "category TEXT NOT NULL,"
                + "message TEXT NOT NULL,"
                + "sms_uuid TEXT,"
                + "detail TEXT)");
        db.execSQL("CREATE INDEX idx_event_uuid ON event(sms_uuid)");
    }

    /**
     * Migrations.
     *
     * <p>Chaque palier est appliqué à la suite, sans {@code break} : une base en
     * version 1 traverse tous les paliers jusqu'à la version courante. Ne jamais
     * supprimer une table ici — la file d'attente est le chemin critique, et une
     * migration destructrice perdrait des SMS jamais envoyés.
     */
    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        Log.i(TAG, "Migration " + oldVersion + " -> " + newVersion);
        if (oldVersion < 2) {
            createEventTable(db);
        }
    }

    // ------------------------------------------------------------------
    // Insertion des travaux
    // ------------------------------------------------------------------

    /** Représente un SMS à envoyer. */
    public static class Job {
        public String smsUuid;
        public String jobId;
        public String number;
        public String body;
        public int segments;
        public long expiresAt;
        public int attempts;
        public int seq;
    }

    /**
     * Insère un travail, en ignorant les doublons.
     *
     * @return true si le travail est nouveau
     */
    public boolean enqueue(String smsUuid, String jobId, String number, String body,
                           int segments, long expiresAt) {
        ContentValues values = new ContentValues();
        values.put("sms_uuid", smsUuid);
        values.put("job_id", jobId);
        values.put("number", number);
        values.put("body", body);
        values.put("segments", Math.max(segments, 1));
        values.put("state", STATE_PENDING);
        values.put("created_at", System.currentTimeMillis());
        values.put("expires_at", expiresAt);
        values.put("next_attempt_at", 0L);
        long rowId = getWritableDatabase().insertWithOnConflict(
                "outbox", null, values, SQLiteDatabase.CONFLICT_IGNORE);
        return rowId != -1;
    }

    /** Travaux prêts à partir, les plus anciens d'abord. */
    public List<Job> dueJobs(int limit) {
        List<Job> jobs = new ArrayList<>();
        long now = System.currentTimeMillis();
        String sql = "SELECT sms_uuid, job_id, number, body, segments, expires_at, attempts, seq"
                + " FROM outbox WHERE state IN (?, ?) AND next_attempt_at <= ?"
                + " ORDER BY created_at ASC LIMIT " + limit;
        try (Cursor cursor = getReadableDatabase().rawQuery(
                sql, new String[]{STATE_PENDING, STATE_FAILED, String.valueOf(now)})) {
            while (cursor.moveToNext()) {
                Job job = new Job();
                job.smsUuid = cursor.getString(0);
                job.jobId = cursor.getString(1);
                job.number = cursor.getString(2);
                job.body = cursor.getString(3);
                job.segments = cursor.getInt(4);
                job.expiresAt = cursor.getLong(5);
                job.attempts = cursor.getInt(6);
                job.seq = cursor.getInt(7);
                jobs.add(job);
            }
        }
        return jobs;
    }

    public int countPending() {
        try (Cursor cursor = getReadableDatabase().rawQuery(
                "SELECT COUNT(*) FROM outbox WHERE state IN (?, ?, ?)",
                new String[]{STATE_PENDING, STATE_SENDING, STATE_FAILED})) {
            return cursor.moveToFirst() ? cursor.getInt(0) : 0;
        }
    }

    /** Travaux dépassés, à abandonner et à signaler comme expirés. */
    public List<Job> expiredJobs() {
        List<Job> jobs = new ArrayList<>();
        long now = System.currentTimeMillis();
        try (Cursor cursor = getReadableDatabase().rawQuery(
                "SELECT sms_uuid, job_id, number, body, segments, expires_at, attempts, seq"
                        + " FROM outbox WHERE state IN (?, ?, ?) AND expires_at > 0 AND expires_at <= ?",
                new String[]{STATE_PENDING, STATE_SENDING, STATE_FAILED, String.valueOf(now)})) {
            while (cursor.moveToNext()) {
                Job job = new Job();
                job.smsUuid = cursor.getString(0);
                job.number = cursor.getString(2);
                job.seq = cursor.getInt(7);
                jobs.add(job);
            }
        }
        return jobs;
    }

    public void markSending(String smsUuid) {
        ContentValues values = new ContentValues();
        values.put("state", STATE_SENDING);
        values.put("attempts", attemptsOf(smsUuid) + 1);
        getWritableDatabase().update("outbox", values, "sms_uuid = ?", new String[]{smsUuid});
    }

    public void markState(String smsUuid, String state, String code, String error) {
        ContentValues values = new ContentValues();
        values.put("state", state);
        if (code != null) {
            values.put("last_code", code);
        }
        if (error != null) {
            values.put("last_error", error);
        }
        if (STATE_FAILED.equals(state)) {
            int attempts = attemptsOf(smsUuid);
            long delay = BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1)];
            values.put("next_attempt_at", System.currentTimeMillis() + delay);
        }
        getWritableDatabase().update("outbox", values, "sms_uuid = ?", new String[]{smsUuid});
    }

    public int attemptsOf(String smsUuid) {
        try (Cursor cursor = getReadableDatabase().rawQuery(
                "SELECT attempts FROM outbox WHERE sms_uuid = ?", new String[]{smsUuid})) {
            return cursor.moveToFirst() ? cursor.getInt(0) : 0;
        }
    }

    /** Numéro de séquence suivant pour ce message. Monotone, persisté. */
    public int nextSeq(String smsUuid) {
        SQLiteDatabase db = getWritableDatabase();
        db.execSQL("UPDATE outbox SET seq = seq + 1 WHERE sms_uuid = ?", new Object[]{smsUuid});
        try (Cursor cursor = db.rawQuery(
                "SELECT seq FROM outbox WHERE sms_uuid = ?", new String[]{smsUuid})) {
            return cursor.moveToFirst() ? cursor.getInt(0) : 1;
        }
    }

    public void remove(String smsUuid) {
        SQLiteDatabase db = getWritableDatabase();
        db.delete("segment", "sms_uuid = ?", new String[]{smsUuid});
        db.delete("outbox", "sms_uuid = ?", new String[]{smsUuid});
    }

    // ------------------------------------------------------------------
    // Segments et accusés de réception
    // ------------------------------------------------------------------
    public void recordSegment(int requestCode, String smsUuid, int segIndex) {
        ContentValues values = new ContentValues();
        values.put("request_code", requestCode);
        values.put("sms_uuid", smsUuid);
        values.put("seg_index", segIndex);
        values.put("created_at", System.currentTimeMillis());
        getWritableDatabase().insertWithOnConflict(
                "segment", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    /** Retrouve le message auquel appartient un code de requête. */
    public String uuidForRequestCode(int requestCode) {
        try (Cursor cursor = getReadableDatabase().rawQuery(
                "SELECT sms_uuid FROM segment WHERE request_code = ?",
                new String[]{String.valueOf(requestCode)})) {
            return cursor.moveToFirst() ? cursor.getString(0) : null;
        }
    }

    /** Incrémente le compteur de segments réussis ou échoués et retourne l'état atteint. */
    public int[] tallySegment(String smsUuid, boolean ok) {
        SQLiteDatabase db = getWritableDatabase();
        db.execSQL("UPDATE outbox SET segments_ok = segments_ok + ?, segments_failed = segments_failed + ?"
                        + " WHERE sms_uuid = ?",
                new Object[]{ok ? 1 : 0, ok ? 0 : 1, smsUuid});
        try (Cursor cursor = db.rawQuery(
                "SELECT segments, segments_ok, segments_failed FROM outbox WHERE sms_uuid = ?",
                new String[]{smsUuid})) {
            if (cursor.moveToFirst()) {
                return new int[]{cursor.getInt(0), cursor.getInt(1), cursor.getInt(2)};
            }
        }
        return new int[]{0, 0, 0};
    }

    // ------------------------------------------------------------------
    // Limitation de débit
    // ------------------------------------------------------------------
    public void logSegmentSent(int count) {
        SQLiteDatabase db = getWritableDatabase();
        long now = System.currentTimeMillis();
        db.beginTransaction();
        try {
            for (int i = 0; i < count; i++) {
                ContentValues values = new ContentValues();
                values.put("sent_at", now);
                db.insert("rate_log", null, values);
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        db.delete("rate_log", "sent_at < ?", new String[]{String.valueOf(now - 300_000L)});
    }

    /** Segments envoyés dans la dernière minute glissante. */
    public int segmentsLastMinute() {
        long since = System.currentTimeMillis() - 60_000L;
        try (Cursor cursor = getReadableDatabase().rawQuery(
                "SELECT COUNT(*) FROM rate_log WHERE sent_at >= ?",
                new String[]{String.valueOf(since)})) {
            return cursor.moveToFirst() ? cursor.getInt(0) : 0;
        }
    }

    // ------------------------------------------------------------------
    // Rapports en attente
    // ------------------------------------------------------------------
    public void spool(String endpoint, String payload) {
        ContentValues values = new ContentValues();
        values.put("endpoint", endpoint);
        values.put("payload", payload);
        values.put("created_at", System.currentTimeMillis());
        getWritableDatabase().insert("spool", null, values);
    }

    public static class SpoolEntry {
        public long id;
        public String endpoint;
        public String payload;
        public int attempts;
    }

    public List<SpoolEntry> spooled(int limit) {
        List<SpoolEntry> entries = new ArrayList<>();
        try (Cursor cursor = getReadableDatabase().rawQuery(
                "SELECT id, endpoint, payload, attempts FROM spool ORDER BY id ASC LIMIT " + limit,
                null)) {
            while (cursor.moveToNext()) {
                SpoolEntry entry = new SpoolEntry();
                entry.id = cursor.getLong(0);
                entry.endpoint = cursor.getString(1);
                entry.payload = cursor.getString(2);
                entry.attempts = cursor.getInt(3);
                entries.add(entry);
            }
        }
        return entries;
    }

    public void spoolDone(long id) {
        getWritableDatabase().delete("spool", "id = ?", new String[]{String.valueOf(id)});
    }

    public void spoolFailed(long id) {
        getWritableDatabase().execSQL(
                "UPDATE spool SET attempts = attempts + 1 WHERE id = ?", new Object[]{id});
        getWritableDatabase().delete("spool", "id = ? AND attempts > 50", new String[]{String.valueOf(id)});
    }

    public int countSpooled() {
        try (Cursor cursor = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM spool", null)) {
            return cursor.moveToFirst() ? cursor.getInt(0) : 0;
        }
    }

    // ------------------------------------------------------------------
    // SMS entrants
    // ------------------------------------------------------------------
    public boolean recordInbound(String id, String number, String body, long receivedAt) {
        ContentValues values = new ContentValues();
        values.put("id", id);
        values.put("number", number);
        values.put("body", body);
        values.put("received_at", receivedAt);
        return getWritableDatabase().insertWithOnConflict(
                "inbound", null, values, SQLiteDatabase.CONFLICT_IGNORE) != -1;
    }

    public Cursor unreportedInbound(int limit) {
        return getReadableDatabase().rawQuery(
                "SELECT id, number, body, received_at FROM inbound WHERE reported = 0"
                        + " ORDER BY received_at ASC LIMIT " + limit, null);
    }

    public void markInboundReported(List<String> ids) {
        if (ids.isEmpty()) {
            return;
        }
        StringBuilder placeholders = new StringBuilder();
        for (int i = 0; i < ids.size(); i++) {
            placeholders.append(i == 0 ? "?" : ",?");
        }
        getWritableDatabase().execSQL(
                "UPDATE inbound SET reported = 1 WHERE id IN (" + placeholders + ")",
                ids.toArray());
    }
}
