package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

public class DeckRegistryTest {
    @Test
    public void mk2_lookup_returns_correct_spec() {
        DeckSpec s = DeckRegistry.lookup(0x0080);
        assertNotNull(s);
        assertEquals("mk2", s.model);
        assertEquals(15, s.keyCount);
        assertEquals(72, s.keyImageW);
        assertEquals(DeckSpec.ImageFormat.JPEG, s.keyImageFormat);
        assertEquals(DeckSpec.TransportKind.V2, s.transport);
        assertTrue(s.capabilities.contains("keys"));
        assertEquals(0, s.dialCount);
    }

    @Test
    public void plus_has_dials_and_lcd() {
        DeckSpec s = DeckRegistry.lookup(0x0084);
        assertNotNull(s);
        assertEquals(4, s.dialCount);
        assertEquals(800, s.lcdW);
        assertEquals(100, s.lcdH);
        assertTrue(s.capabilities.contains("dials"));
        assertTrue(s.capabilities.contains("lcd"));
    }

    @Test
    public void neo_has_infobars_and_touchpoints() {
        DeckSpec s = DeckRegistry.lookup(0x009a);
        assertNotNull(s);
        assertEquals(2, s.infoBarCount);
        assertEquals(2, s.touchPoints);
        assertTrue(s.capabilities.contains("infobars"));
        assertTrue(s.capabilities.contains("touchpoints"));
    }

    @Test
    public void mini_uses_bmp_rot270() {
        DeckSpec s = DeckRegistry.lookup(0x0063);
        assertNotNull(s);
        assertEquals(DeckSpec.ImageFormat.BMP_BGR_ROT270, s.keyImageFormat);
        assertEquals(DeckSpec.TransportKind.V1, s.transport);
    }

    @Test
    public void original_v1_uses_bmp_rot180() {
        DeckSpec s = DeckRegistry.lookup(0x0060);
        assertNotNull(s);
        assertEquals(DeckSpec.ImageFormat.BMP_BGR_ROT180, s.keyImageFormat);
        assertEquals(DeckSpec.TransportKind.V1, s.transport);
    }

    @Test
    public void unknown_pid_returns_null() {
        assertNull(DeckRegistry.lookup(0xDEAD));
    }

    @Test
    public void all_seven_models_present() {
        int[] pids = {0x0060, 0x0063, 0x006c, 0x006d, 0x0080, 0x0084, 0x009a};
        for (int pid : pids) {
            assertNotNull("missing pid 0x" + Integer.toHexString(pid), DeckRegistry.lookup(pid));
        }
    }
}
