package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

/**
 * BatteryClimber: the level the power state climbs to, and why (plan L4, L12), and the climb held until
 * MARGIN points above its threshold.
 */
public class BatteryClimberTest {

    private static final BatteryClimber DEFAULTS = new BatteryClimber(true, 30, 15);

    private static PushLevelPolicy.PowerState battery(int pct) {
        return new PushLevelPolicy.PowerState(false, false, false, pct);
    }

    private static PushLevelPolicy.PowerState plugged(int pct) {
        return new PushLevelPolicy.PowerState(false, true, false, pct);
    }

    private static PushLevelPolicy.PowerState saver(int pct) {
        return new PushLevelPolicy.PowerState(false, false, true, pct);
    }

    private static void assertClimb(int level, String reason, PushLevelPolicy.Climb c) {
        assertEquals("level", level, c.level);
        assertEquals("reason", reason, c.reason);
    }

    @Test
    public void pluggedReturnsToTheChosenLevelAtAnyPercentage() {
        for (int pct : new int[] {1, 5, 12, 20, 29, 50, 100}) {
            for (int chosen = 1; chosen <= 5; chosen++) {
                assertClimb(chosen, "", DEFAULTS.climb(chosen, plugged(pct)));
            }
        }
    }

    @Test
    public void oneLevelMoreUnderTheFirstThreshold() {
        assertClimb(2, "below_one", DEFAULTS.climb(1, battery(29)));
        assertClimb(3, "below_one", DEFAULTS.climb(2, battery(20)));
        assertClimb(4, "below_one", DEFAULTS.climb(3, battery(15)));
        assertClimb(1, "", DEFAULTS.climb(1, battery(30)));
    }

    @Test
    public void twoLevelsMoreUnderTheSecond() {
        assertClimb(3, "below_two", DEFAULTS.climb(1, battery(14)));
        assertClimb(4, "below_two", DEFAULTS.climb(2, battery(5)));
    }

    @Test
    public void climbingNeverReaches5UnlessChosen() {
        assertClimb(4, "below_two", DEFAULTS.climb(3, battery(10)));
        assertClimb(4, "", DEFAULTS.climb(4, battery(5)));
        assertClimb(5, "", DEFAULTS.climb(5, battery(5)));
        assertClimb(5, "", DEFAULTS.climb(5, saver(5)));
        assertClimb(4, "", DEFAULTS.climb(4, saver(5)));
    }

    @Test
    public void saverMeansLevel3AtLeast() {
        assertClimb(3, "saver", DEFAULTS.climb(1, saver(80)));
        assertClimb(3, "saver", DEFAULTS.climb(2, saver(80)));
        assertClimb(3, "", DEFAULTS.climb(3, saver(80)));
    }

    @Test
    public void saverAppliesWithTheSwitchOffThresholdsDoNot() {
        BatteryClimber off = new BatteryClimber(false, 30, 15);
        assertClimb(3, "saver", off.climb(1, saver(80)));
        assertClimb(1, "", off.climb(1, battery(5)));
        assertClimb(3, "", off.climb(3, battery(5)));
    }

    @Test
    public void aThresholdOfNoneNeverClimbs() {
        BatteryClimber none = new BatteryClimber(true, 0, 0);
        assertClimb(1, "", none.climb(1, battery(1)));
        assertClimb(3, "", none.climb(3, battery(0)));
    }

    @Test
    public void theSecondThresholdAloneClimbsTwoLevels() {
        BatteryClimber second = new BatteryClimber(true, 0, 15);
        assertClimb(3, "below_two", second.climb(1, battery(12)));
        assertClimb(1, "", second.climb(1, battery(20)));
    }

    @Test
    public void eachThresholdFollowsItsOwnLabelWhenThePairIsInverted() {
        BatteryClimber inverted = new BatteryClimber(true, 15, 30);
        assertClimb(3, "below_two", inverted.climb(1, battery(20)));
        assertClimb(3, "below_two", inverted.climb(1, battery(12)));
        assertClimb(2, "below_one", DEFAULTS.climb(1, battery(20)));
    }

    @Test
    public void theReasonNamesWhatSetTheLevel() {
        // the saver lifts a one-step climb (1 to 2) to 3: the saver set it
        assertClimb(3, "saver", DEFAULTS.climb(1, saver(25)));
        // two steps reach 3 on their own: the saver changes nothing
        assertClimb(3, "below_two", DEFAULTS.climb(1, saver(10)));
        // the threshold climbs 3 to 4, above what the saver asks
        assertClimb(4, "below_one", DEFAULTS.climb(3, saver(25)));
    }

    @Test
    public void ofReadsThePhonePrefs() {
        BatteryClimber c = BatteryClimber.of(new PhonePrefs(false, 40, 0, BrowserMode.WAIT));
        assertClimb(1, "", c.climb(1, battery(10)));
        BatteryClimber d = BatteryClimber.of(PhonePrefs.DEFAULT);
        assertClimb(2, "below_one", d.climb(1, battery(25)));
    }

    @Test
    public void differsIgnoresAPercentageChangeInsideABand() {
        PushLevelPolicy.Effective at25 = PushLevelPolicy.resolve(1, battery(25), true, DEFAULTS);
        PushLevelPolicy.Effective at20 = PushLevelPolicy.resolve(1, battery(20), true, DEFAULTS);
        PushLevelPolicy.Effective at14 = PushLevelPolicy.resolve(1, battery(14), true, DEFAULTS);
        assertFalse(BatteryClimber.differs(at25, at20));
        assertTrue(BatteryClimber.differs(at20, at14));
        assertTrue(BatteryClimber.differs(null, at20));
        // the same level under another reason differs
        PushLevelPolicy.Effective bySaver = PushLevelPolicy.resolve(1, saver(80), true, DEFAULTS);
        PushLevelPolicy.Effective byThreshold = PushLevelPolicy.resolve(1, battery(14), true, DEFAULTS);
        assertEquals(bySaver.level, byThreshold.level);
        assertTrue(BatteryClimber.differs(bySaver, byThreshold));
        // level 2 changes mode when plugged in, at the same level and reason
        PushLevelPolicy.Effective off = PushLevelPolicy.resolve(2, battery(80), true, DEFAULTS);
        PushLevelPolicy.Effective on = PushLevelPolicy.resolve(2, plugged(80), true, DEFAULTS);
        assertTrue(BatteryClimber.differs(off, on));
    }

    // ---- hysteresis: a climb is released at threshold + MARGIN ----

    /**
     * Feeds the percentages one after the other to a chosen level 1, the
     * steps each climb answers handed to the next as its held steps, as
     * the store keeps them between runs; returns the levels.
     */
    private static List<Integer> path(BatteryClimber prefs, PushLevelPolicy.PowerState... states) {
        List<Integer> levels = new ArrayList<>();
        int held = 0;
        for (PushLevelPolicy.PowerState s : states) {
            PushLevelPolicy.Climb c = prefs.withHeld(held).climb(1, s);
            levels.add(c.level);
            held = c.steps;
        }
        return levels;
    }

    private static List<Integer> path(BatteryClimber prefs, int... pcts) {
        PushLevelPolicy.PowerState[] states = new PushLevelPolicy.PowerState[pcts.length];
        for (int i = 0; i < pcts.length; i++) states[i] = battery(pcts[i]);
        return path(prefs, states);
    }

    private static List<Integer> levels(Integer... l) {
        List<Integer> out = new ArrayList<>();
        Collections.addAll(out, l);
        return out;
    }

    @Test
    public void theMarginIsFivePoints() {
        assertEquals(5, BatteryClimber.MARGIN);
    }

    @Test
    public void aClimbUnder15HoldsUntil20() {
        // the second threshold alone: two levels under 15 %, kept at 16 and 19, released at 20
        assertEquals(levels(1, 3, 3, 3, 1), path(new BatteryClimber(true, 0, 15), 40, 14, 16, 19, 20));
        // the first threshold alone: one level, the same margin
        assertEquals(levels(1, 2, 2, 2, 1), path(new BatteryClimber(true, 15, 0), 40, 14, 16, 19, 20));
    }

    @Test
    public void theStepsOutAreTheStateIn() {
        BatteryClimber second = new BatteryClimber(true, 0, 15);
        assertEquals(2, second.climb(1, battery(14)).steps);
        assertEquals(0, second.climb(1, battery(16)).steps);
        PushLevelPolicy.Climb held = second.withHeld(2).climb(1, battery(16));
        assertClimb(3, "below_two", held);
        assertEquals(2, held.steps);
        assertEquals(0, second.withHeld(2).climb(1, battery(20)).steps);
    }

    @Test
    public void chargingReleasesAtOnce() {
        BatteryClimber second = new BatteryClimber(true, 0, 15);
        assertEquals(levels(3, 1, 1), path(second, battery(14), plugged(16), battery(16)));
        PushLevelPolicy.Climb c = second.withHeld(2).climb(1, plugged(16));
        assertClimb(1, "", c);
        assertEquals(0, c.steps);
    }

    @Test
    public void aJitteringGaugeClimbsOnce() {
        List<Integer> l = path(new BatteryClimber(true, 0, 15), 40, 14, 16, 14, 16, 14, 16);
        assertEquals(levels(1, 3, 3, 3, 3, 3, 3), l);
        int climbs = 0;
        for (int i = 1; i < l.size(); i++) if (l.get(i) > l.get(i - 1)) climbs++;
        assertEquals(1, climbs);
    }

    @Test
    public void thresholdsSetToNoneOrTheSwitchOffReleaseAHeldClimb() {
        PushLevelPolicy.Climb none = new BatteryClimber(true, 0, 0, 2).climb(1, battery(16));
        assertClimb(1, "", none);
        assertEquals(0, none.steps);
        PushLevelPolicy.Climb off = new BatteryClimber(false, 30, 15, 2).climb(1, battery(16));
        assertClimb(1, "", off);
        assertEquals(0, off.steps);
    }

    @Test
    public void bothThresholdsStepDownOneMarginAtATime() {
        // 30/15: two levels under 15, one level from 20 (still under 30), none from 35
        assertEquals(levels(1, 3, 3, 2, 2, 1), path(DEFAULTS, 40, 12, 18, 20, 33, 36));
        assertClimb(2, "below_one", DEFAULTS.withHeld(1).climb(1, battery(33)));
        assertClimb(3, "below_two", DEFAULTS.withHeld(2).climb(1, battery(18)));
    }

    @Test
    public void theSaverIsNotHeld() {
        assertEquals(levels(3, 1), path(DEFAULTS, saver(80), battery(80)));
        assertEquals(0, DEFAULTS.climb(1, saver(80)).steps);
        // a held threshold climb under the saver keeps its own reason when above it
        assertClimb(4, "below_one", DEFAULTS.withHeld(1).climb(3, saver(33)));
    }

    @Test
    public void aLevelTheBatteryDoesNotRaiseHoldsNothing() {
        // a chosen 5, and a chosen 4 already at the cap: the level stays, nothing is held
        PushLevelPolicy.Climb five = DEFAULTS.climb(5, battery(12));
        assertClimb(5, "", five);
        assertEquals(0, five.steps);
        PushLevelPolicy.Climb four = DEFAULTS.withHeld(2).climb(4, battery(12));
        assertClimb(4, "", four);
        assertEquals(0, four.steps);
        // a build without realtime maps 1 and 2 to 3: a climb to 3 raises nothing
        PushLevelPolicy.Effective clamped = PushLevelPolicy.resolve(1, battery(12), false, DEFAULTS);
        assertEquals(3, clamped.level);
        assertEquals("", clamped.climbReason);
        assertEquals(0, clamped.climbSteps);
        assertEquals(0, PushLevelPolicy.resolve(2, battery(20), false, DEFAULTS).climbSteps);
    }

    @Test
    public void aClimbHeldBeforeLevelFiveDoesNotComeBackAfterIt() {
        // nothing decides at level 5, so a charge there is never seen: the hold ends on the move to 5
        MapKeyValue kv = new MapKeyValue();
        new PushSettingsStore(kv).put(1, false, PhonePrefs.DEFAULT, null, null);
        assertEquals(3, BatteryClimber.resolveStored(new PushSettingsStore(kv), battery(12), true).level);
        assertEquals(2, new PushSettingsStore(kv).climbSteps());
        new PushSettingsStore(kv).put(5, false, PhonePrefs.DEFAULT, null, null);
        BatteryClimber.resolveStored(new PushSettingsStore(kv), battery(12), true);
        assertEquals(0, new PushSettingsStore(kv).climbSteps());
        new PushSettingsStore(kv).put(1, false, PhonePrefs.DEFAULT, null, null);
        PushLevelPolicy.Effective back = BatteryClimber.resolveStored(new PushSettingsStore(kv), battery(17), true);
        // what 17 % climbs now (under 30), not the two levels held before
        assertEquals(2, back.level);
        assertEquals("below_one", back.climbReason);
    }

    @Test
    public void resolveCarriesTheSteps() {
        assertEquals(2, PushLevelPolicy.resolve(1, battery(12), true, DEFAULTS).climbSteps);
        assertEquals(0, PushLevelPolicy.resolve(1, plugged(12), true, DEFAULTS).climbSteps);
        assertEquals(0, PushLevelPolicy.resolve(1, battery(12), true, PushLevelPolicy.NO_CLIMB).climbSteps);
        PushLevelPolicy.Effective e = PushLevelPolicy.resolve(1, battery(12), true, DEFAULTS);
        assertEquals(2, PushLevelPolicy.withoutService(e).climbSteps);
    }

    @Test
    public void resolveStoredKeepsTheHeldStepsAcrossProcesses() {
        MapKeyValue kv = new MapKeyValue();
        new PushSettingsStore(kv).put(1, false, PhonePrefs.DEFAULT, null, null);
        PushLevelPolicy.Effective e = BatteryClimber.resolveStored(new PushSettingsStore(kv), battery(14), true);
        assertEquals(3, e.level);
        // each read is a fresh store over the same file, as a job in a new process reads it
        assertEquals(3, BatteryClimber.resolveStored(new PushSettingsStore(kv), battery(17), true).level);
        PushLevelPolicy.Effective at20 = BatteryClimber.resolveStored(new PushSettingsStore(kv), battery(20), true);
        assertEquals(2, at20.level);
        assertEquals("below_one", at20.climbReason);
        assertEquals(2, BatteryClimber.resolveStored(new PushSettingsStore(kv), battery(33), true).level);
        assertEquals(1, BatteryClimber.resolveStored(new PushSettingsStore(kv), battery(36), true).level);
        assertEquals(0, new PushSettingsStore(kv).climbSteps());
    }

    @Test
    public void resolveStoredReleasesOnTheChargerForTheNextRead() {
        MapKeyValue kv = new MapKeyValue();
        new PushSettingsStore(kv).put(1, false, PhonePrefs.DEFAULT, null, null);
        BatteryClimber.resolveStored(new PushSettingsStore(kv), battery(14), true);
        assertEquals(2, new PushSettingsStore(kv).climbSteps());
        assertEquals(1, BatteryClimber.resolveStored(new PushSettingsStore(kv), plugged(16), true).level);
        assertEquals(0, new PushSettingsStore(kv).climbSteps());
        // unplugged at 16: only what 16 % climbs now (under 30), the two held levels are gone
        assertEquals(2, BatteryClimber.resolveStored(new PushSettingsStore(kv), battery(16), true).level);
    }

    @Test
    public void anUnreadableStoredStepCountReadsAsNone() {
        MapKeyValue kv = new MapKeyValue();
        kv.put("climbSteps", "two");
        assertEquals(0, new PushSettingsStore(kv).climbSteps());
        kv.put("climbSteps", "7");
        assertEquals(0, new PushSettingsStore(kv).climbSteps());
        // put() replaces the mirror and leaves the held steps alone
        PushSettingsStore s = new PushSettingsStore(kv);
        s.setClimbSteps(1);
        s.put(2, false, PhonePrefs.DEFAULT, null, null);
        assertEquals(1, s.climbSteps());
    }
}
