package ca.erplibre.home;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

/**
 * Journal local de la passerelle SMS.
 *
 * <p>Odoo garde la vue métier des envois. Ce journal garde ce que seul
 * l'appareil sait : permission retirée, carte SIM absente, réseau coupé, cycle
 * jamais déclenché, accusé arrivé sans message correspondant. L'écran de la
 * passerelle n'affichait que l'état courant, qui disparaît au bout de trente
 * secondes — il ne restait donc rien pour diagnostiquer un envoi de la veille.
 *
 * <h2>Ce qui est écrit</h2>
 *
 * <p>Par défaut, métadonnées et états seulement : horodatage, catégorie,
 * identifiant d'envoi, code Android. Le corps des messages et les numéros
 * complets ne sont écrits que si l'exploitant élève le niveau — un choix qui
 * met des données de membres sur un appareil qui peut se perdre, et qui doit
 * donc être pris sciemment.
 *
 * <h2>Purge</h2>
 *
 * <p>Deux seuils, jamais ligne à ligne. Effacer une entrée à chaque insertion
 * coûterait une écriture supplémentaire par événement et fragmenterait l'index
 * en permanence. Ici on ne fait rien tant que la base reste sous le seuil haut,
 * puis on redescend au seuil bas en une seule transaction — soit une purge
 * toutes les quelques milliers d'insertions.
 */
public class SmsJournal {

    private static final String TAG = "SmsJournal";

    public static final String LEVEL_INFO = "info";
    public static final String LEVEL_WARN = "warn";
    public static final String LEVEL_ERROR = "error";

    public static final String CAT_CYCLE = "cycle";
    public static final String CAT_SEND = "send";
    public static final String CAT_RECEIPT = "receipt";
    public static final String CAT_INBOUND = "inbound";
    public static final String CAT_NETWORK = "network";
    public static final String CAT_CONFIG = "config";
    /**
     * Vie du service : demarrages, arrets, morts, relances automatiques.
     *
     * <p>Une categorie a part, et non un sous-cas de `cycle` : quand la
     * passerelle se tait, la premiere question est « depuis quand est-elle
     * morte, et qui l'a tuee ». Noyee parmi des milliers de lignes de cycle,
     * la reponse est introuvable ; ici elle tient en un filtre.
     */
    public static final String CAT_SERVICE = "service";

    /** Au-delà, la purge se déclenche. */
    static final long HIGH_WATER_BYTES = 10L * 1024 * 1024;
    /** La purge redescend jusque-là. */
    static final long LOW_WATER_BYTES = 7L * 1024 * 1024;

    /**
     * Une insertion sur N vérifie la taille.
     *
     * <p>Interroger les PRAGMA à chaque écriture annulerait le bénéfice du
     * traitement par lots. Entre deux vérifications, le journal peut dépasser
     * le seuil haut de quelques dizaines de kilo-octets au plus : sans
     * importance face à 10 Mo, et cela garde l'insertion à une seule écriture.
     */
    private static final int CHECK_EVERY = 200;

    private static int sinceCheck = 0;

    private final SmsOutbox outbox;
    private final SmsGatewayConfig config;

    public SmsJournal(Context context) {
        this.outbox = SmsOutbox.get(context);
        this.config = new SmsGatewayConfig(context);
    }

    // ------------------------------------------------------------------
    // Écriture
    // ------------------------------------------------------------------

    public void info(String category, String message) {
        write(LEVEL_INFO, category, message, null, null);
    }

    public void info(String category, String message, String smsUuid) {
        write(LEVEL_INFO, category, message, smsUuid, null);
    }

    public void warn(String category, String message, String smsUuid) {
        write(LEVEL_WARN, category, message, smsUuid, null);
    }

    public void error(String category, String message, String smsUuid) {
        write(LEVEL_ERROR, category, message, smsUuid, null);
    }

    /**
     * Écrit une entrée avec un détail sensible — corps de message, numéro
     * complet.
     *
     * <p>Le détail n'est retenu que si le niveau de journalisation l'autorise.
     * L'entrée, elle, est toujours écrite : on garde la trace de l'événement
     * même quand on n'en garde pas le contenu.
     */
    public void withDetail(String level, String category, String message,
                           String smsUuid, String detail) {
        write(level, category, message, smsUuid,
              config.journalKeepsBodies() ? detail : null);
    }

    private void write(String level, String category, String message,
                       String smsUuid, String detail) {
        try {
            SQLiteDatabase db = outbox.getWritableDatabase();
            ContentValues values = new ContentValues();
            values.put("at", System.currentTimeMillis());
            values.put("level", level);
            values.put("category", category);
            values.put("message", message);
            values.put("sms_uuid", smsUuid);
            values.put("detail", detail);
            db.insert("event", null, values);
            maybePurge(db);
        } catch (Exception e) {
            // Le journal ne doit jamais faire tomber ce qu'il observe.
            Log.e(TAG, "Écriture impossible : " + e.getMessage());
        }
    }

    // ------------------------------------------------------------------
    // Purge
    // ------------------------------------------------------------------

    private static synchronized void maybePurge(SQLiteDatabase db) {
        if (++sinceCheck < CHECK_EVERY) {
            return;
        }
        sinceCheck = 0;
        purgeIfNeeded(db);
    }

    /**
     * Ramène le journal sous le seuil bas s'il a dépassé le seuil haut.
     *
     * <p>La taille retenue est {@code (page_count - freelist_count) × page_size},
     * pas la taille du fichier. C'est délibéré : une suppression ne rend pas
     * l'espace au système sans VACUUM, elle le verse dans la liste libre. Mesurer
     * le fichier ferait donc re-déclencher la purge à chaque vérification alors
     * qu'elle a déjà fait son travail — le journal se viderait entièrement. Ce
     * qu'on veut, c'est que le fichier plafonne et que les pages libérées
     * resservent, ce que cette mesure décrit exactement.
     */
    static void purgeIfNeeded(SQLiteDatabase db) {
        long used = usedBytes(db);
        if (used <= HIGH_WATER_BYTES) {
            return;
        }
        long rows = count(db, "SELECT COUNT(*) FROM event");
        if (rows <= 1) {
            // Le volume ne vient pas du journal : les autres tables sont le
            // chemin critique, on n'y touche pas.
            Log.w(TAG, "Base à " + used + " octets sans que le journal en soit la cause");
            return;
        }
        // Combien de lignes tiennent sous le seuil bas, au prorata de l'occupation
        // moyenne. Approximatif, et c'est suffisant : la borne est un plafond de
        // disque, pas une garantie au kilo-octet près.
        long keep = Math.max(1, rows * LOW_WATER_BYTES / used);
        long cutoff = count(db,
                "SELECT id FROM event ORDER BY id DESC LIMIT 1 OFFSET " + keep);
        if (cutoff <= 0) {
            return;
        }
        db.beginTransaction();
        try {
            int deleted = db.delete("event", "id <= ?", new String[]{String.valueOf(cutoff)});
            db.setTransactionSuccessful();
            Log.i(TAG, "Purge du journal : " + deleted + " entrées, " + used + " octets occupés");
        } finally {
            db.endTransaction();
        }
    }

    private static long usedBytes(SQLiteDatabase db) {
        long pageCount = count(db, "PRAGMA page_count");
        long freeList = count(db, "PRAGMA freelist_count");
        long pageSize = count(db, "PRAGMA page_size");
        return Math.max(0, pageCount - freeList) * pageSize;
    }

    private static long count(SQLiteDatabase db, String sql) {
        try (Cursor c = db.rawQuery(sql, null)) {
            return c.moveToFirst() ? c.getLong(0) : 0L;
        } catch (Exception e) {
            return 0L;
        }
    }

    // ------------------------------------------------------------------
    // Lecture
    // ------------------------------------------------------------------

    /** Une entrée du journal. */
    public static class Entry {
        public long id;
        public long at;
        public String level;
        public String category;
        public String message;
        public String smsUuid;
        public String detail;
    }

    /**
     * Les entrées les plus récentes d'abord.
     *
     * @param category filtre facultatif ; {@code null} pour tout
     * @param limit    nombre maximal d'entrées
     */
    public List<Entry> entries(String category, int limit) {
        List<Entry> out = new ArrayList<>();
        String where = category == null ? null : "category = ?";
        String[] args = category == null ? null : new String[]{category};
        try (Cursor c = outbox.getReadableDatabase().query(
                "event",
                new String[]{"id", "at", "level", "category", "message", "sms_uuid", "detail"},
                where, args, null, null, "id DESC", String.valueOf(limit))) {
            while (c.moveToNext()) {
                Entry e = new Entry();
                e.id = c.getLong(0);
                e.at = c.getLong(1);
                e.level = c.getString(2);
                e.category = c.getString(3);
                e.message = c.getString(4);
                e.smsUuid = c.getString(5);
                e.detail = c.getString(6);
                out.add(e);
            }
        } catch (Exception e) {
            Log.e(TAG, "Lecture impossible : " + e.getMessage());
        }
        return out;
    }

    /** Efface tout le journal. Ne touche à rien d'autre. */
    public int clear() {
        try {
            return outbox.getWritableDatabase().delete("event", null, null);
        } catch (Exception e) {
            Log.e(TAG, "Effacement impossible : " + e.getMessage());
            return 0;
        }
    }

    /** Nombre d'entrées et octets occupés, pour l'écran de supervision. */
    public long size() {
        return count(outbox.getReadableDatabase(), "SELECT COUNT(*) FROM event");
    }

    public long usedBytes() {
        return usedBytes(outbox.getReadableDatabase());
    }
}
