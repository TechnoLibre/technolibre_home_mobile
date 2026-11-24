package ca.erplibre.home.chatpush;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/**
 * User-visible strings of the native side. The app mirrors its translations
 * here; a key the mirror lacks (or holds empty) falls back to French, so a
 * notification is worded before the app has ever run.
 */
final class PushStrings {

    private static final Map<String, String> FALLBACK = new HashMap<>();

    static {
        FALLBACK.put("new_message", "Nouveau message");
        FALLBACK.put("you", "Vous");
        FALLBACK.put("new_message_server", "Nouveau message — {server}");
        FALLBACK.put("summary_one", "1 nouveau message — {server}");
        FALLBACK.put("summary", "{n} nouveaux messages — {server}");
        FALLBACK.put("channel_chat", "Clavardage");
        FALLBACK.put("channel_inbox", "Boîte de réception");
        FALLBACK.put("channel_status", "État des notifications");
        FALLBACK.put("channel_permanent", "Services permanents");
        FALLBACK.put("permanent_listening_one", "À l'écoute d'un serveur");
        FALLBACK.put("permanent_listening", "À l'écoute de {n} serveurs");
        FALLBACK.put("permanent_waiting", "En attente du réseau");
        FALLBACK.put("permanent_polling", "Vérification toutes les 15 minutes");
        FALLBACK.put("permanent_failing", "{server} : {reason}");
        FALLBACK.put("status_not_listening", "Les notifications de {server} ne passent plus : {reason}");
        FALLBACK.put("status_session_expired", "Ouvrez l'app pour reprendre les notifications de {server}");
        FALLBACK.put("reason_unauthorized", "jeton refusé par ntfy");
        FALLBACK.put("reason_forbidden", "accès refusé par ntfy");
        FALLBACK.put("reason_unreachable", "ntfy injoignable");
        FALLBACK.put("reason_odoo_unreachable", "Odoo injoignable");
        FALLBACK.put("reason_rate_limited", "trop de requêtes");
        FALLBACK.put("reason_http_refused", "http non autorisé");
        FALLBACK.put("reason_cleartext_blocked", "http bloqué par cette version de l'app");
        FALLBACK.put("reason_session_expired", "session Odoo expirée");
        FALLBACK.put("reason_protocol", "réponse inattendue");
        FALLBACK.put("action_reply", "Répondre");
        FALLBACK.put("action_reply_hint", "Votre réponse");
        FALLBACK.put("action_mark_read", "Marquer lu");
        FALLBACK.put("action_mute", "Muet 1 h");
        FALLBACK.put("action_react", "👍");
        FALLBACK.put("handoff_one", "Ouvrez l'app pour terminer une action — {server}");
        FALLBACK.put("handoff", "Ouvrez l'app pour terminer {n} actions — {server}");
        FALLBACK.put("action_unsent", "Action non envoyée — {server}");
    }

    private final Map<String, String> mirrored;

    PushStrings(Map<String, String> mirrored) {
        this.mirrored = mirrored == null
                ? Collections.<String, String>emptyMap()
                : new HashMap<>(mirrored);
    }

    /** The mirrored string, else the French fallback, else the key itself. */
    String get(String key) {
        String v = mirrored.get(key);
        if (v != null && !v.isEmpty()) return v;
        v = FALLBACK.get(key);
        return v != null ? v : key;
    }

    /** get(key) with every {name} replaced by vars.get("name"); a placeholder without a value stays. */
    String format(String key, Map<String, String> vars) {
        String out = get(key);
        if (vars != null) {
            for (Map.Entry<String, String> e : vars.entrySet()) {
                out = out.replace("{" + e.getKey() + "}", e.getValue() == null ? "" : e.getValue());
            }
        }
        return out;
    }
}
