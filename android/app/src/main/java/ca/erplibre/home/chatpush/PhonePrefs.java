package ca.erplibre.home.chatpush;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * The phone-wide chat push choices the app mirrors: automatic climbing
 * (switch and two battery thresholds, 0 for none) and the browser mode.
 * Read from and written to {"climb": {"auto", "oneBelow", "twoBelow"},
 * "browserMode"}, the shape of the app's mirror; a missing or invalid value
 * reads as its default, so a mirror written before these keys existed reads
 * as DEFAULT.
 */
public final class PhonePrefs {

    /** The thresholds the options offer, in percent; 0 is « none ». */
    private static final int[] THRESHOLDS = {0, 10, 15, 20, 30, 40, 50};
    private static final int DEFAULT_ONE_BELOW = 30;
    private static final int DEFAULT_TWO_BELOW = 15;

    static final PhonePrefs DEFAULT = new PhonePrefs(true, DEFAULT_ONE_BELOW, DEFAULT_TWO_BELOW, BrowserMode.WAIT);

    final boolean climbAuto;
    /** Battery percentage under which the level climbs one step, 0 for never. */
    final int oneBelow;
    /** Battery percentage under which the level climbs two steps, 0 for never. */
    final int twoBelow;
    final BrowserMode browserMode;

    /** A threshold outside the offered ones becomes its default, a null mode WAIT. */
    PhonePrefs(boolean climbAuto, int oneBelow, int twoBelow, BrowserMode browserMode) {
        this.climbAuto = climbAuto;
        this.oneBelow = threshold(oneBelow, DEFAULT_ONE_BELOW);
        this.twoBelow = threshold(twoBelow, DEFAULT_TWO_BELOW);
        this.browserMode = browserMode == null ? BrowserMode.WAIT : browserMode;
    }

    /** The prefs of a mirror or of a stored copy; null reads as DEFAULT. */
    public static PhonePrefs of(JSONObject mirror) {
        if (mirror == null) return DEFAULT;
        JSONObject climb = mirror.optJSONObject("climb");
        if (climb == null) climb = new JSONObject();
        return new PhonePrefs(climb.optBoolean("auto", DEFAULT.climbAuto),
                climb.optInt("oneBelow", DEFAULT_ONE_BELOW),
                climb.optInt("twoBelow", DEFAULT_TWO_BELOW),
                BrowserMode.fromKey(mirror.optString("browserMode", "")));
    }

    /** The JSON of() reads back. */
    JSONObject toJson() throws JSONException {
        JSONObject climb = new JSONObject();
        climb.put("auto", climbAuto);
        climb.put("oneBelow", oneBelow);
        climb.put("twoBelow", twoBelow);
        JSONObject o = new JSONObject();
        o.put("climb", climb);
        o.put("browserMode", browserMode.key());
        return o;
    }

    private static int threshold(int v, int fallback) {
        for (int t : THRESHOLDS) {
            if (t == v) return v;
        }
        return fallback;
    }
}
