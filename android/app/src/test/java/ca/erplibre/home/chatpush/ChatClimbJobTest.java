package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** ChatClimbJob.wanted: job 4825 waits for the charger while the level is climbed (plan L4). */
public class ChatClimbJobTest {

    private static final BatteryClimber DEFAULTS = new BatteryClimber(true, 30, 15);

    private static PushLevelPolicy.Effective resolve(int chosen, boolean plugged, boolean saver, int pct,
            boolean realtimeBuild) {
        return PushLevelPolicy.resolve(chosen, new PushLevelPolicy.PowerState(false, plugged, saver, pct),
                realtimeBuild, DEFAULTS);
    }

    @Test
    public void scheduledWhileClimbedAndUnplugged() {
        assertTrue(ChatClimbJob.wanted(resolve(1, false, false, 12, true), false));
        assertTrue(ChatClimbJob.wanted(resolve(1, false, true, 80, true), false));
        assertTrue(ChatClimbJob.wanted(resolve(3, false, false, 20, true), false));
    }

    @Test
    public void cancelledWhenPluggedOrAtTheChosenLevel() {
        // the door's state climbs, the phone itself is on the charger: nothing to wait for
        assertFalse(ChatClimbJob.wanted(resolve(1, false, false, 12, true), true));
        assertFalse(ChatClimbJob.wanted(resolve(1, true, false, 12, true), true));
        assertFalse(ChatClimbJob.wanted(resolve(1, false, false, 80, true), false));
        assertFalse(ChatClimbJob.wanted(resolve(4, false, false, 5, true), false));
        assertFalse(ChatClimbJob.wanted(resolve(5, false, true, 5, true), false));
    }

    @Test
    public void heldStepsAlwaysHaveTheJobWaitingForTheCharger() {
        // a hold no job waits on would outlive a charge nobody saw
        for (boolean realtimeBuild : new boolean[] {true, false}) {
            for (boolean saver : new boolean[] {false, true}) {
                for (int chosen = 1; chosen <= 5; chosen++) {
                    for (int held = 0; held <= 2; held++) {
                        for (int pct = 0; pct <= 100; pct++) {
                            PushLevelPolicy.Effective e = PushLevelPolicy.resolve(chosen,
                                    new PushLevelPolicy.PowerState(false, false, saver, pct), realtimeBuild,
                                    DEFAULTS.withHeld(held));
                            assertTrue("chosen " + chosen + " held " + held + " at " + pct,
                                    e.climbSteps == 0 || ChatClimbJob.wanted(e, false));
                        }
                    }
                }
            }
        }
    }

    @Test
    public void notWantedForABuildClamp() {
        assertFalse(ChatClimbJob.wanted(resolve(1, false, false, 80, false), false));
        assertFalse(ChatClimbJob.wanted(resolve(2, false, false, 20, false), false));
        assertFalse(ChatClimbJob.wanted(resolve(1, false, true, 80, false), false));
    }
}
