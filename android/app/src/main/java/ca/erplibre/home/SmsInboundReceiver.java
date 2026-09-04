package ca.erplibre.home;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.provider.Telephony;
import android.telephony.SmsMessage;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

/**
 * Capte les SMS entrants pour en extraire les désabonnements.
 *
 * <p>L'application n'est pas l'application de messagerie par défaut du
 * téléphone, et c'est un choix : le devenir imposerait de gérer les codes
 * d'authentification bancaires du téléphone. La conséquence à connaître est que
 * les messages entrants restent AUSSI visibles dans l'application Messages du
 * téléphone. Une réponse du genre « ma fille est à l'hôpital » est donc lisible
 * sur l'écran de veille de l'appareil : il doit être verrouillé et rangé.
 *
 * <p>Ce que ce récepteur garantit, en revanche, c'est le traitement automatique
 * des STOP. La loi canadienne anti-pourriel exige qu'un désabonnement soit
 * honoré dans les dix jours ouvrables ; sur un canal où personne ne lit les
 * réponses, l'automatiser est la seule façon de le garantir.
 */
public class SmsInboundReceiver extends BroadcastReceiver {

    private static final String TAG = "SmsInboundReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) {
            return;
        }
        SmsGatewayConfig config = new SmsGatewayConfig(context);
        if (!config.isEnabled() || !config.isConfigured()) {
            return;
        }

        SmsMessage[] messages = Telephony.Sms.Intents.getMessagesFromIntent(intent);
        if (messages == null || messages.length == 0) {
            return;
        }

        // Les SMS longs arrivent en plusieurs parties : on recolle par expéditeur.
        Map<String, StringBuilder> bodies = new HashMap<>();
        Map<String, Long> timestamps = new HashMap<>();
        for (SmsMessage message : messages) {
            if (message == null) {
                continue;
            }
            String from = message.getOriginatingAddress();
            if (from == null) {
                continue;
            }
            bodies.computeIfAbsent(from, key -> new StringBuilder())
                    .append(message.getMessageBody() == null ? "" : message.getMessageBody());
            timestamps.putIfAbsent(from, message.getTimestampMillis());
        }

        SmsOutbox outbox = SmsOutbox.get(context);
        for (Map.Entry<String, StringBuilder> entry : bodies.entrySet()) {
            String from = entry.getKey();
            String body = entry.getValue().toString();
            long receivedAt = timestamps.getOrDefault(from, System.currentTimeMillis());
            // Identifiant déterministe : un même message capté deux fois ne sera
            // pas enregistré deux fois, ni côté téléphone ni côté Odoo.
            String id = Integer.toHexString((from + "|" + receivedAt + "|" + body).hashCode())
                    + "-" + receivedAt;
            if (outbox.recordInbound(id, from, body, receivedAt)) {
                Log.i(TAG, "SMS entrant enregistré de " + from);
                new SmsJournal(context).withDetail(SmsJournal.LEVEL_INFO,
                        SmsJournal.CAT_INBOUND, "SMS entrant reçu", null,
                        from + " : " + body);
            }
        }

        flushInbound(context, outbox);
    }

    /** Remonte les entrants non encore rapportés. */
    static void flushInbound(Context context, SmsOutbox outbox) {
        try {
            OdooReporter reporter = new OdooReporter(context);
            JSONArray messages = new JSONArray();
            java.util.List<String> ids = new java.util.ArrayList<>();
            try (android.database.Cursor cursor = outbox.unreportedInbound(50)) {
                while (cursor.moveToNext()) {
                    JSONObject message = new JSONObject();
                    message.put("id", cursor.getString(0));
                    message.put("from", cursor.getString(1));
                    message.put("body", cursor.getString(2));
                    message.put("at", cursor.getLong(3) / 1000L);
                    messages.put(message);
                    ids.add(cursor.getString(0));
                }
            }
            if (messages.length() == 0) {
                return;
            }
            JSONObject payload = reporter.envelope();
            payload.put("messages", messages);
            reporter.submit(OdooReporter.ENDPOINT_INBOUND, payload);
            // Marqué comme rapporté parce que la file de rapports garantit
            // l'acheminement : elle réessaie jusqu'à ce qu'Odoo accepte.
            outbox.markInboundReported(ids);
        } catch (Exception e) {
            Log.e(TAG, "Remontée des entrants impossible : " + e.getMessage());
            new SmsJournal(context).error(SmsJournal.CAT_INBOUND,
                    "Remontée des entrants impossible : " + e.getMessage(), null);
        }
    }
}
