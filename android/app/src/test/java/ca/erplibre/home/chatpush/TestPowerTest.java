package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

/** TestPower, the -PsyncTest door's fake power state: its pure parts (plan L5). */
public class TestPowerTest {

    private static final PushLevelPolicy.PowerState REAL = new PushLevelPolicy.PowerState(true, true, false, 90);

    private static Map<String, String> map(String... kv) {
        Map<String, String> m = new HashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put(kv[i], kv[i + 1]);
        return m;
    }

    @Test
    public void anOverrideReplacesPluggedSaverAndPercentageKeepsWifi() {
        PushLevelPolicy.PowerState s = TestPower.apply(map("plugged", "false", "saver", "true", "pct", "12"), REAL);
        assertTrue(s.wifi);
        assertFalse(s.plugged);
        assertTrue(s.saver);
        assertEquals(12, s.batteryPct);
        // a partial override keeps the real value of what it leaves out
        PushLevelPolicy.PowerState p = TestPower.apply(map("pct", "12"), REAL);
        assertTrue(p.plugged);
        assertFalse(p.saver);
        assertEquals(12, p.batteryPct);
    }

    @Test
    public void clearReturnsTheRealState() {
        Map<String, String> cleared = TestPower.fromExtras(map("kind", "power", "clear", "true"));
        assertNotNull(cleared);
        assertTrue(cleared.isEmpty());
        assertSame(REAL, TestPower.apply(cleared, REAL));
        assertSame(REAL, TestPower.apply(null, REAL));
    }

    @Test
    public void theDoorReadsAPowerBroadcastWithoutATag() {
        Map<String, String> stored = TestPower.fromExtras(map("kind", "power", "plugged", "false", "pct", "12"));
        assertEquals(map("plugged", "false", "pct", "12"), stored);
        assertEquals(map("saver", "true"), TestPower.fromExtras(map("kind", "power", "saver", "TRUE")));
        // malformed: a value that is no boolean, a percentage out of range or not a number, nothing to set,
        // clear beside a value
        assertNull(TestPower.fromExtras(map("kind", "power", "plugged", "oui")));
        assertNull(TestPower.fromExtras(map("kind", "power", "pct", "101")));
        assertNull(TestPower.fromExtras(map("kind", "power", "pct", "-1")));
        assertNull(TestPower.fromExtras(map("kind", "power", "pct", "douze")));
        assertNull(TestPower.fromExtras(map("kind", "power")));
        assertNull(TestPower.fromExtras(map("kind", "power", "clear", "false")));
        assertNull(TestPower.fromExtras(map("kind", "power", "clear", "true", "pct", "12")));
        assertNull(TestPower.fromExtras(null));
    }
}
