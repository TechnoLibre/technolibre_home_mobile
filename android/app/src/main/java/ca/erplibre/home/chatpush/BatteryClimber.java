package ca.erplibre.home.chatpush;

/**
 * Raises the chosen level from the power state. Plugged in, or a chosen 5,
 * keeps the chosen level. Otherwise, when auto is on, a battery under
 * twoBelow climbs two levels and one under oneBelow climbs one (a threshold
 * of 0 never climbs; each climbs by its own count, whichever is the higher
 * percentage), and the climb stops at 4: only the user turns the app
 * silent. Battery saver then means level 3 at least, whatever auto says:
 * Android's saver restricts background network, so levels 1 and 2 could
 * not keep their promise.
 *
 * A threshold climb is released on the way back up only at its threshold
 * plus MARGIN points, so a gauge jittering around a threshold climbs once:
 * the decision takes the threshold steps the previous one answered (held)
 * and answers the steps now in force (Climb.steps). Plugging in releases at
 * once; the saver holds nothing, it ends when the saver turns off. A chosen
 * 5 keeps following the battery, so a move back to 1 starts from the path
 * the battery took.
 *
 * climb is pure and Android-free; resolveStored is the one entry that reads
 * and writes the held steps, in PushSettingsStore, so that a decision made
 * in a new process (a job after the process died) continues the last one.
 */
final class BatteryClimber implements PushLevelPolicy.LevelClimber {

    static final String SAVER = "saver";
    static final String BELOW_ONE = "below_one";
    static final String BELOW_TWO = "below_two";

    /** Points above a threshold at which a climb under it is released. */
    static final int MARGIN = 5;

    /** The highest level a climb reaches; 5 is the user's choice only. */
    private static final int CAP = 4;
    /** The level battery saver asks at least. */
    private static final int SAVER_LEVEL = 3;

    private final boolean auto;
    private final int oneBelow;
    private final int twoBelow;
    /** The threshold steps (0, 1 or 2) the previous decision answered. */
    private final int held;

    BatteryClimber(boolean auto, int oneBelow, int twoBelow) {
        this(auto, oneBelow, twoBelow, 0);
    }

    BatteryClimber(boolean auto, int oneBelow, int twoBelow, int held) {
        this.auto = auto;
        this.oneBelow = oneBelow;
        this.twoBelow = twoBelow;
        this.held = held;
    }

    /** The climber of the mirrored phone-wide prefs, nothing held. */
    static BatteryClimber of(PhonePrefs p) {
        return of(p, 0);
    }

    /** The climber of the mirrored phone-wide prefs, holding the steps of the previous decision. */
    static BatteryClimber of(PhonePrefs p, int held) {
        return new BatteryClimber(p.climbAuto, p.oneBelow, p.twoBelow, held);
    }

    /** The same thresholds, holding steps instead. */
    BatteryClimber withHeld(int steps) {
        return new BatteryClimber(auto, oneBelow, twoBelow, steps);
    }

    /**
     * The mirrored level resolved against the power state p with the held
     * steps the store keeps, which then takes the steps of this decision
     * (written only when they changed). Two concurrent callers may write in
     * either order; both decided on the same store and nearly the same
     * battery, and the next decision reads whichever stayed.
     */
    static PushLevelPolicy.Effective resolveStored(PushSettingsStore s, PushLevelPolicy.PowerState p,
            boolean realtimeBuild) {
        int held = s.climbSteps();
        PushLevelPolicy.Effective e = PushLevelPolicy.resolve(s.level(), p, realtimeBuild, of(s.prefs(), held));
        if (e.climbSteps != held) s.setClimbSteps(e.climbSteps);
        return e;
    }

    /**
     * Whether b changes what a holds the app to: its level, its mode or the
     * reason it shows. A percentage that moves inside one threshold band,
     * or inside the margin that holds a climb, changes none of them. A null
     * a differs from anything.
     */
    static boolean differs(PushLevelPolicy.Effective a, PushLevelPolicy.Effective b) {
        if (a == null || b == null) return a != b;
        return a.level != b.level || a.mode != b.mode || !a.climbReason.equals(b.climbReason);
    }

    /**
     * The threshold steps in force at pct: those under a threshold now, or
     * the held ones while pct is still under that threshold plus MARGIN
     * (two held steps keep one while under oneBelow plus MARGIN). Auto off
     * or a threshold of 0 holds nothing.
     */
    private int steps(int pct) {
        if (!auto) return 0;
        int now = 0;
        if (twoBelow > 0 && pct < twoBelow) now = 2;
        else if (oneBelow > 0 && pct < oneBelow) now = 1;
        int kept = 0;
        if (held >= 2 && twoBelow > 0 && pct < twoBelow + MARGIN) kept = 2;
        else if (held >= 1 && oneBelow > 0 && pct < oneBelow + MARGIN) kept = 1;
        return Math.max(now, kept);
    }

    /**
     * The reason is SAVER when the saver set the level, else BELOW_TWO or
     * BELOW_ONE (the threshold crossed, held or not) when the level is
     * above the chosen one, else "". Plugged in answers 0 steps.
     */
    @Override
    public PushLevelPolicy.Climb climb(int chosen, PushLevelPolicy.PowerState s) {
        if (s.plugged) return new PushLevelPolicy.Climb(chosen, "", 0);
        int steps = steps(s.batteryPct);
        if (chosen >= 5) return new PushLevelPolicy.Climb(chosen, "", steps);
        int level = Math.max(chosen, Math.min(chosen + steps, CAP));
        if (s.saver && level < SAVER_LEVEL) return new PushLevelPolicy.Climb(SAVER_LEVEL, SAVER, steps);
        if (level == chosen) return new PushLevelPolicy.Climb(chosen, "", steps);
        return new PushLevelPolicy.Climb(level, steps == 2 ? BELOW_TWO : BELOW_ONE, steps);
    }
}
