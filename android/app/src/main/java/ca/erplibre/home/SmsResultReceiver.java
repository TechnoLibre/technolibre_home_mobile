package ca.erplibre.home;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.telephony.SmsManager;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Reçoit les accusés « remis au réseau » et « reçu par le destinataire ».
 *
 * <h3>Pourquoi l'action est FIXE</h3>
 *
 * <p>Un {@link android.content.IntentFilter} apparie l'action par égalité de
 * chaîne exacte. Une action construite par travail — {@code …SMS_SENT/<job>/<i>} —
 * ne peut donc être appariée par AUCUN filtre : tous les accusés seraient perdus,
 * Odoo conclurait à un échec total pour des SMS réellement partis, puis
 * republierait. Fausses alertes et doublons systématiques : le pire mode de
 * défaillance possible pour un canal d'alerte.
 *
 * <p>L'unicité nécessaire entre segments est donc obtenue autrement : par un
 * <em>code de requête</em> distinct à chaque {@link android.app.PendingIntent},
 * tiré d'un compteur persisté ({@link SmsGatewayConfig#nextRequestCode()}).
 * {@code filterEquals} ignore le code de requête, mais
 * {@code PendingIntent.getBroadcast} en fait des instances distinctes, donc les
 * extras de chacune sont préservés.
 */
public class SmsResultReceiver extends BroadcastReceiver {

    private static final String TAG = "SmsResultReceiver";

    public static final String ACTION_SENT = "ca.erplibre.home.SMS_SENT";
    public static final String ACTION_DELIVERED = "ca.erplibre.home.SMS_DELIVERED";

    public static final String EXTRA_UUID = "sms_uuid";
    public static final String EXTRA_SEGMENT = "segment_index";
    public static final String EXTRA_REQUEST_CODE = "request_code";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) {
            return;
        }
        String smsUuid = intent.getStringExtra(EXTRA_UUID);
        int requestCode = intent.getIntExtra(EXTRA_REQUEST_CODE, 0);
        SmsOutbox outbox = SmsOutbox.get(context);

        // Repli : si les extras ont été perdus, on retrouve le message par le
        // code de requête, que la table `segment` conserve.
        if (smsUuid == null && requestCode != 0) {
            smsUuid = outbox.uuidForRequestCode(requestCode);
        }
        if (smsUuid == null) {
            Log.w(TAG, "Accusé sans message identifiable, action " + action);
            return;
        }

        int resultCode = getResultCode();
        if (ACTION_SENT.equals(action)) {
            handleSent(context, outbox, smsUuid, resultCode);
        } else if (ACTION_DELIVERED.equals(action)) {
            handleDelivered(context, outbox, smsUuid, resultCode);
        }
    }

    private void handleSent(Context context, SmsOutbox outbox, String smsUuid, int resultCode) {
        boolean ok = resultCode == Activity.RESULT_OK;
        int[] tally = outbox.tallySegment(smsUuid, ok);
        int total = tally[0];
        int done = tally[1] + tally[2];
        if (done < total) {
            // On attend les autres segments avant de conclure.
            return;
        }
        if (tally[2] > 0) {
            String code = resultCodeName(resultCode);
            outbox.markState(smsUuid, SmsOutbox.STATE_FAILED, code, null);
            int attempts = outbox.attemptsOf(smsUuid);
            if (attempts >= SmsOutbox.MAX_ATTEMPTS) {
                report(context, outbox, smsUuid, "failed", code,
                        "Abandon après " + attempts + " tentatives");
                outbox.remove(smsUuid);
            } else {
                Log.i(TAG, "Nouvelle tentative prévue pour " + smsUuid + " (" + code + ")");
            }
        } else {
            outbox.markState(smsUuid, SmsOutbox.STATE_SUBMITTED, null, null);
            report(context, outbox, smsUuid, "submitted", null, null);
        }
    }

    private void handleDelivered(Context context, SmsOutbox outbox, String smsUuid, int resultCode) {
        if (resultCode == Activity.RESULT_OK) {
            outbox.markState(smsUuid, SmsOutbox.STATE_DELIVERED, null, null);
            report(context, outbox, smsUuid, "delivered", null, null);
            outbox.remove(smsUuid);
        } else {
            // Un rapport de livraison négatif est une information réelle : le
            // réseau a explicitement renoncé. À distinguer de l'absence de
            // rapport, qui ne prouve rien.
            String code = resultCodeName(resultCode);
            report(context, outbox, smsUuid, "failed", code, "Rapport de livraison négatif");
            outbox.remove(smsUuid);
        }
    }

    private void report(Context context, SmsOutbox outbox, String smsUuid,
                        String state, String code, String reason) {
        try {
            OdooReporter reporter = new OdooReporter(context);
            JSONObject event = new JSONObject();
            event.put("uuid", smsUuid);
            event.put("seq", outbox.nextSeq(smsUuid));
            event.put("state", state);
            event.put("at", System.currentTimeMillis() / 1000L);
            if (code != null) {
                event.put("code", code);
            }
            if (reason != null) {
                event.put("reason", reason);
            }
            JSONArray events = new JSONArray();
            events.put(event);
            JSONObject payload = reporter.envelope();
            payload.put("events", events);
            reporter.submit(OdooReporter.ENDPOINT_REPORT, payload);
        } catch (Exception e) {
            Log.e(TAG, "Rapport impossible pour " + smsUuid + " : " + e.getMessage());
        }
    }

    /**
     * Nom lisible d'un code de résultat.
     *
     * <p>Ces noms sont ceux que le module Odoo sait traduire en un
     * {@code provider_error} accepté par le cœur : tout code inconnu y serait
     * aplati en « Unknown error ».
     */
    public static String resultCodeName(int resultCode) {
        switch (resultCode) {
            case SmsManager.RESULT_ERROR_GENERIC_FAILURE: return "RESULT_ERROR_GENERIC_FAILURE";
            case SmsManager.RESULT_ERROR_RADIO_OFF: return "RESULT_ERROR_RADIO_OFF";
            case SmsManager.RESULT_ERROR_NULL_PDU: return "RESULT_ERROR_NULL_PDU";
            case SmsManager.RESULT_ERROR_NO_SERVICE: return "RESULT_ERROR_NO_SERVICE";
            case SmsManager.RESULT_ERROR_LIMIT_EXCEEDED: return "RESULT_ERROR_LIMIT_EXCEEDED";
            case SmsManager.RESULT_ERROR_FDN_CHECK_FAILURE: return "RESULT_ERROR_FDN_CHECK_FAILURE";
            case SmsManager.RESULT_ERROR_SHORT_CODE_NOT_ALLOWED: return "RESULT_ERROR_SHORT_CODE_NOT_ALLOWED";
            case SmsManager.RESULT_ERROR_SHORT_CODE_NEVER_ALLOWED: return "RESULT_ERROR_SHORT_CODE_NEVER_ALLOWED";
            case SmsManager.RESULT_NETWORK_REJECT: return "RESULT_NETWORK_REJECT";
            case SmsManager.RESULT_INVALID_ARGUMENTS: return "RESULT_INVALID_ARGUMENTS";
            case SmsManager.RESULT_INVALID_STATE: return "RESULT_INVALID_STATE";
            case SmsManager.RESULT_NO_MEMORY: return "RESULT_NO_MEMORY";
            case SmsManager.RESULT_INVALID_SMS_FORMAT: return "RESULT_INVALID_SMS_FORMAT";
            case SmsManager.RESULT_SYSTEM_ERROR: return "RESULT_SYSTEM_ERROR";
            case SmsManager.RESULT_MODEM_ERROR: return "RESULT_MODEM_ERROR";
            case SmsManager.RESULT_NETWORK_ERROR: return "RESULT_NETWORK_ERROR";
            case SmsManager.RESULT_ENCODING_ERROR: return "RESULT_ENCODING_ERROR";
            case SmsManager.RESULT_INVALID_SMSC_ADDRESS: return "RESULT_INVALID_SMSC_ADDRESS";
            case SmsManager.RESULT_OPERATION_NOT_ALLOWED: return "RESULT_OPERATION_NOT_ALLOWED";
            case SmsManager.RESULT_NO_RESOURCES: return "RESULT_NO_RESOURCES";
            case SmsManager.RESULT_CANCELLED: return "RESULT_CANCELLED";
            case SmsManager.RESULT_REQUEST_NOT_SUPPORTED: return "RESULT_REQUEST_NOT_SUPPORTED";
            case SmsManager.RESULT_RIL_RADIO_NOT_AVAILABLE: return "RESULT_RIL_RADIO_NOT_AVAILABLE";
            case SmsManager.RESULT_RIL_NETWORK_REJECT: return "RESULT_RIL_NETWORK_REJECT";
            case SmsManager.RESULT_RIL_SIM_ABSENT: return "RESULT_RIL_SIM_ABSENT";
            default: return "RESULT_CODE_" + resultCode;
        }
    }
}
