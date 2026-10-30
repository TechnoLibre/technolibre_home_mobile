package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PushLevelPolicyTest {

    private static PushLevelPolicy.PowerState power(boolean wifi, boolean plugged) {
        return new PushLevelPolicy.PowerState(wifi, plugged, false, 80);
    }

    private static PushLevelPolicy.Effective resolve(int level, boolean wifi, boolean plugged) {
        return PushLevelPolicy.resolve(level, power(wifi, plugged), true, PushLevelPolicy.NO_CLIMB);
    }

    @Test
    public void levelTableAcrossWifiAndPlugged() {
        for (boolean wifi : new boolean[] {false, true}) {
            for (boolean plugged : new boolean[] {false, true}) {
                PushLevelPolicy.Effective e1 = resolve(1, wifi, plugged);
                assertEquals(PushLevelPolicy.Mode.REALTIME, e1.mode);
                assertTrue(e1.permanentService);

                PushLevelPolicy.Effective e2 = resolve(2, wifi, plugged);
                assertEquals(wifi || plugged ? PushLevelPolicy.Mode.REALTIME : PushLevelPolicy.Mode.POLL_15, e2.mode);
                assertTrue(e2.permanentService);

                PushLevelPolicy.Effective e3 = resolve(3, wifi, plugged);
                assertEquals(PushLevelPolicy.Mode.POLL_15, e3.mode);
                assertFalse(e3.permanentService);

                PushLevelPolicy.Effective e4 = resolve(4, wifi, plugged);
                assertEquals(PushLevelPolicy.Mode.POLL_60, e4.mode);
                assertFalse(e4.permanentService);

                PushLevelPolicy.Effective e5 = resolve(5, wifi, plugged);
                assertEquals(PushLevelPolicy.Mode.OFF, e5.mode);
                assertFalse(e5.permanentService);
            }
        }
    }

    @Test
    public void levels1And2MapTo3WithoutTheRealtimeBuild() {
        for (int level = 1; level <= 2; level++) {
            PushLevelPolicy.Effective e =
                    PushLevelPolicy.resolve(level, power(true, true), false, PushLevelPolicy.NO_CLIMB);
            assertEquals(3, e.level);
            assertEquals(PushLevelPolicy.Mode.POLL_15, e.mode);
            assertFalse(e.permanentService);
        }
        assertEquals(4, PushLevelPolicy.resolve(4, power(true, true), false, PushLevelPolicy.NO_CLIMB).level);
    }

    @Test
    public void level2IsRealtimeWhenPlugged() {
        PushLevelPolicy.Effective e = resolve(2, false, true);
        assertEquals(2, e.level);
        assertEquals(PushLevelPolicy.Mode.REALTIME, e.mode);
        assertEquals(PushLevelPolicy.Mode.POLL_15, resolve(2, false, false).mode);
    }

    @Test
    public void aClimberResultAbove5Is5() {
        PushLevelPolicy.LevelClimber wild = (chosen, s) -> new PushLevelPolicy.Climb(9, "below_two");
        PushLevelPolicy.Effective e = PushLevelPolicy.resolve(2, power(true, true), true, wild);
        assertEquals(5, e.level);
        assertEquals(PushLevelPolicy.Mode.OFF, e.mode);
        assertEquals("below_two", e.climbReason);
        PushLevelPolicy.LevelClimber low = (chosen, s) -> new PushLevelPolicy.Climb(-3, "");
        assertEquals(1, PushLevelPolicy.resolve(2, power(true, true), true, low).level);
    }

    @Test
    public void theClimberSeesTheChosenLevelAndThePowerState() {
        PushLevelPolicy.PowerState s = new PushLevelPolicy.PowerState(false, false, true, 12);
        PushLevelPolicy.LevelClimber saver = (chosen, st) -> st.saver
                ? new PushLevelPolicy.Climb(chosen + 2, "saver")
                : new PushLevelPolicy.Climb(chosen, "");
        PushLevelPolicy.Effective e = PushLevelPolicy.resolve(2, s, true, saver);
        assertEquals(4, e.level);
        assertEquals("saver", e.climbReason);
    }

    @Test
    public void noClimbKeepsTheChosenLevelWithoutReason() {
        PushLevelPolicy.Climb c =
                PushLevelPolicy.NO_CLIMB.climb(2, new PushLevelPolicy.PowerState(false, false, true, 5));
        assertEquals(2, c.level);
        assertEquals("", c.reason);
        assertEquals("", resolve(2, false, false).climbReason);
    }

    @Test
    public void aBuildClampIsNoClimb() {
        PushLevelPolicy.PowerState at20 = new PushLevelPolicy.PowerState(false, false, false, 20);
        PushLevelPolicy.Effective off = PushLevelPolicy.resolve(1, at20, false, new BatteryClimber(true, 0, 0));
        assertEquals(3, off.level);
        assertEquals("", off.climbReason);
        // a climb to 2 or 3 that the build maps to 3 anyway is no climb either
        BatteryClimber defaults = new BatteryClimber(true, 30, 15);
        PushLevelPolicy.Effective one = PushLevelPolicy.resolve(1, at20, false, defaults);
        assertEquals(3, one.level);
        assertEquals("", one.climbReason);
        PushLevelPolicy.Effective two = PushLevelPolicy.resolve(2, at20, false, defaults);
        assertEquals(3, two.level);
        assertEquals("", two.climbReason);
        PushLevelPolicy.PowerState saver = new PushLevelPolicy.PowerState(false, false, true, 80);
        assertEquals("", PushLevelPolicy.resolve(1, saver, false, defaults).climbReason);
        // past the build's 3, the climb keeps its reason
        PushLevelPolicy.Effective three = PushLevelPolicy.resolve(3, at20, false, defaults);
        assertEquals(4, three.level);
        assertEquals("below_one", three.climbReason);
    }

    @Test
    public void withoutServiceKeepsTheClimbReason() {
        PushLevelPolicy.PowerState at20wifi = new PushLevelPolicy.PowerState(true, false, false, 20);
        PushLevelPolicy.Effective e = PushLevelPolicy.resolve(1, at20wifi, true, new BatteryClimber(true, 30, 15));
        assertEquals(2, e.level);
        assertEquals("below_one", PushLevelPolicy.withoutService(e).climbReason);
    }

    @Test
    public void odooDirectIsOffOnlyAtLevel5() {
        for (int level = 1; level <= 4; level++) {
            assertTrue(resolve(level, true, true).odooDirect);
        }
        assertFalse(resolve(5, true, true).odooDirect);
    }
}
