package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** BatteryClimber: the level the power state climbs to, and why (plan L4, L12). */
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
}
