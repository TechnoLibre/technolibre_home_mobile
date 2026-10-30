package ca.erplibre.home.chatpush;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * The fake power state of the test door (ChatTestDoor, kind power),
 * packaged only in the -PsyncTest build (src/synctest/). The door stores
 * an override of plugged, saver and the battery percentage in its own
 * preferences file; ChatPushRuntime finds this class by name and passes
 * each real power state through over(), so the level climbs as if the
 * battery said so. Wifi is never overridden, and the real plugged state
 * still decides job 4825 (ChatClimbJob.wanted). An empty override is the
 * real state.
 */
final class TestPower {

    static final String FILE = "erplibre_chat_test_power";
    static final String PLUGGED = "plugged";
    static final String SAVER = "saver";
    static final String PCT = "pct";
    static final String CLEAR = "clear";

    private TestPower() {}

    /** real with the stored override applied; real when nothing is stored. */
    static PushLevelPolicy.PowerState over(Context c, PushLevelPolicy.PowerState real) {
        Map<String, String> stored = new HashMap<>();
        for (Map.Entry<String, ?> e : prefs(c).getAll().entrySet()) {
            if (e.getValue() instanceof String) stored.put(e.getKey(), (String) e.getValue());
        }
        return apply(stored, real);
    }

    /** Replaces the stored override with override (as fromExtras returns it); empty clears it. */
    static void store(Context c, Map<String, String> override) {
        SharedPreferences.Editor ed = prefs(c).edit().clear();
        for (Map.Entry<String, String> e : override.entrySet()) ed.putString(e.getKey(), e.getValue());
        // written before the door re-applies the level, which reads it back
        ed.commit();
    }

    /**
     * real with each value stored (plugged, saver as "true"/"false", pct as
     * an integer) replacing its own; real itself when stored is null or
     * empty. Pure.
     */
    static PushLevelPolicy.PowerState apply(Map<String, String> stored, PushLevelPolicy.PowerState real) {
        if (stored == null || stored.isEmpty()) return real;
        boolean plugged = stored.containsKey(PLUGGED) ? Boolean.parseBoolean(stored.get(PLUGGED)) : real.plugged;
        boolean saver = stored.containsKey(SAVER) ? Boolean.parseBoolean(stored.get(SAVER)) : real.saver;
        int pct = real.batteryPct;
        if (stored.containsKey(PCT)) {
            try {
                pct = Integer.parseInt(stored.get(PCT));
            } catch (NumberFormatException e) {
                // a hand-edited file: the real percentage stays
            }
        }
        return new PushLevelPolicy.PowerState(real.wifi, plugged, saver, pct);
    }

    /**
     * The override a power broadcast asks for, from its extras as strings:
     * plugged and saver (true or false, any case), pct (0 to 100), at least
     * one of them; or clear=true alone, which gives an empty map. Other
     * extras (kind) are ignored. Null when malformed. Pure.
     */
    static Map<String, String> fromExtras(Map<String, String> extras) {
        if (extras == null) return null;
        Map<String, String> out = new HashMap<>();
        if (extras.containsKey(CLEAR)) {
            boolean alone = !extras.containsKey(PLUGGED) && !extras.containsKey(SAVER) && !extras.containsKey(PCT);
            return alone && "true".equalsIgnoreCase(extras.get(CLEAR)) ? out : null;
        }
        for (String key : new String[] {PLUGGED, SAVER}) {
            if (!extras.containsKey(key)) continue;
            String v = extras.get(key) == null ? "" : extras.get(key).toLowerCase(Locale.ROOT);
            if (!"true".equals(v) && !"false".equals(v)) return null;
            out.put(key, v);
        }
        if (extras.containsKey(PCT)) {
            int pct;
            try {
                pct = Integer.parseInt(extras.get(PCT));
            } catch (NumberFormatException e) {
                return null;
            }
            if (pct < 0 || pct > 100) return null;
            out.put(PCT, Integer.toString(pct));
        }
        return out.isEmpty() ? null : out;
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }
}
