package ca.erplibre.home.chatpush;

/**
 * Raises the chosen level from the power state, statelessly, so the
 * permanent service, the jobs and health reach the same level after any
 * death. Plugged in, or a chosen 5, keeps the chosen level. Otherwise, when
 * auto is on, a battery under twoBelow climbs two levels and one under
 * oneBelow climbs one (a threshold of 0 never climbs; each climbs by its
 * own count, whichever is the higher percentage), and the climb stops at 4:
 * only the user turns the app silent. Battery saver then means level 3 at
 * least, whatever auto says: Android's saver restricts background network,
 * so levels 1 and 2 could not keep their promise.
 *
 * Pure and Android-free.
 */
final class BatteryClimber implements PushLevelPolicy.LevelClimber {

    static final String SAVER = "saver";
    static final String BELOW_ONE = "below_one";
    static final String BELOW_TWO = "below_two";

    /** The highest level a climb reaches; 5 is the user's choice only. */
    private static final int CAP = 4;
    /** The level battery saver asks at least. */
    private static final int SAVER_LEVEL = 3;

    private final boolean auto;
    private final int oneBelow;
    private final int twoBelow;

    BatteryClimber(boolean auto, int oneBelow, int twoBelow) {
        this.auto = auto;
        this.oneBelow = oneBelow;
        this.twoBelow = twoBelow;
    }

    /** The climber of the mirrored phone-wide prefs. */
    static BatteryClimber of(PhonePrefs p) {
        return new BatteryClimber(p.climbAuto, p.oneBelow, p.twoBelow);
    }

    /**
     * Whether b changes what a holds the app to: its level, its mode or the
     * reason it shows. A percentage that moves inside one threshold band
     * changes none of them. A null a differs from anything.
     */
    static boolean differs(PushLevelPolicy.Effective a, PushLevelPolicy.Effective b) {
        if (a == null || b == null) return a != b;
        return a.level != b.level || a.mode != b.mode || !a.climbReason.equals(b.climbReason);
    }

    /**
     * The reason is SAVER when the saver set the level, else BELOW_TWO or
     * BELOW_ONE (the threshold crossed) when the level is above the chosen
     * one, else "".
     */
    @Override
    public PushLevelPolicy.Climb climb(int chosen, PushLevelPolicy.PowerState s) {
        if (s.plugged || chosen >= 5) return new PushLevelPolicy.Climb(chosen, "");
        int steps = 0;
        if (auto) {
            if (twoBelow > 0 && s.batteryPct < twoBelow) steps = 2;
            else if (oneBelow > 0 && s.batteryPct < oneBelow) steps = 1;
        }
        int level = Math.max(chosen, Math.min(chosen + steps, CAP));
        if (s.saver && level < SAVER_LEVEL) return new PushLevelPolicy.Climb(SAVER_LEVEL, SAVER);
        if (level == chosen) return new PushLevelPolicy.Climb(chosen, "");
        return new PushLevelPolicy.Climb(level, steps == 2 ? BELOW_TWO : BELOW_ONE);
    }
}
