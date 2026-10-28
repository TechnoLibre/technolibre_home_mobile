package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PushLevelPolicyTest {

    private static PushLevelPolicy.PowerState power(boolean wifi, boolean charging) {
        return new PushLevelPolicy.PowerState(wifi, charging, false, 80);
    }

    private static PushLevelPolicy.Effective resolve(int level, boolean wifi, boolean charging) {
        return PushLevelPolicy.resolve(level, power(wifi, charging), true, PushLevelPolicy.NO_CLIMB);
    }

    @Test
    public void levelTableAcrossWifiAndCharging() {
        for (boolean wifi : new boolean[] {false, true}) {
            for (boolean charging : new boolean[] {false, true}) {
                PushLevelPolicy.Effective e1 = resolve(1, wifi, charging);
                assertEquals(PushLevelPolicy.Mode.REALTIME, e1.mode);
                assertTrue(e1.permanentService);

                PushLevelPolicy.Effective e2 = resolve(2, wifi, charging);
                assertEquals(wifi || charging ? PushLevelPolicy.Mode.REALTIME : PushLevelPolicy.Mode.POLL_15, e2.mode);
                assertTrue(e2.permanentService);

                PushLevelPolicy.Effective e3 = resolve(3, wifi, charging);
                assertEquals(PushLevelPolicy.Mode.POLL_15, e3.mode);
                assertFalse(e3.permanentService);

                PushLevelPolicy.Effective e4 = resolve(4, wifi, charging);
                assertEquals(PushLevelPolicy.Mode.POLL_60, e4.mode);
                assertFalse(e4.permanentService);

                PushLevelPolicy.Effective e5 = resolve(5, wifi, charging);
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
    public void aClimberResultAbove5Is5() {
        PushLevelPolicy.LevelClimber wild = (chosen, s) -> 9;
        PushLevelPolicy.Effective e = PushLevelPolicy.resolve(2, power(true, true), true, wild);
        assertEquals(5, e.level);
        assertEquals(PushLevelPolicy.Mode.OFF, e.mode);
        PushLevelPolicy.LevelClimber low = (chosen, s) -> -3;
        assertEquals(1, PushLevelPolicy.resolve(2, power(true, true), true, low).level);
    }

    @Test
    public void theClimberSeesTheChosenLevelAndThePowerState() {
        PushLevelPolicy.PowerState s = new PushLevelPolicy.PowerState(false, false, true, 12);
        PushLevelPolicy.LevelClimber saver = (chosen, st) -> st.saver ? chosen + 2 : chosen;
        assertEquals(4, PushLevelPolicy.resolve(2, s, true, saver).level);
    }

    @Test
    public void odooDirectIsOffOnlyAtLevel5() {
        for (int level = 1; level <= 4; level++) {
            assertTrue(resolve(level, true, true).odooDirect);
        }
        assertFalse(resolve(5, true, true).odooDirect);
    }
}
