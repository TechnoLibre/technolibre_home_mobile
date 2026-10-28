package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class PushSettingsStoreTest {

    @Test
    public void defaultsBeforeAnyMirror() {
        PushSettingsStore s = new PushSettingsStore(new MapKeyValue());
        assertEquals(3, s.level());
        assertFalse(s.allowHttp());
        assertTrue(s.accounts().isEmpty());
        assertEquals("Nouveau message", s.strings().get("new_message"));
        assertEquals(0L, s.lastBeat());
    }

    @Test
    public void theMirrorRoundTrips() {
        MapKeyValue kv = new MapKeyValue();
        PushSettingsStore s = new PushSettingsStore(kv);
        Map<Long, ChannelInfo> ch = new HashMap<>();
        ch.put(12L, new ChannelInfo("General", "channel"));
        AccountView a = new AccountView("cfg1", "Odoo exemple", LockScreenMode.ALWAYS, ch);
        s.put(1, true, Collections.singletonMap("new_message", "New message"), Collections.singletonList(a));
        PushSettingsStore again = new PushSettingsStore(kv);
        assertEquals(1, again.level());
        assertTrue(again.allowHttp());
        assertEquals("New message", again.strings().get("new_message"));
        AccountView b = again.account("cfg1");
        assertEquals("Odoo exemple", b.label);
        assertEquals(LockScreenMode.ALWAYS, b.lockScreen);
        assertEquals("channel", b.channels.get(12L).type);
        assertNull(again.account("nope"));
    }

    @Test
    public void flagsBeatAndOpenKey() {
        MapKeyValue kv = new MapKeyValue();
        PushSettingsStore s = new PushSettingsStore(kv);
        s.setForeground(true);
        s.beat(42L);
        assertTrue(s.foreground());
        assertEquals(42L, s.lastBeat());
        String k = s.openKey();
        assertTrue(k.length() >= 24);
        assertEquals(k, new PushSettingsStore(kv).openKey());
    }

    @Test
    public void engineStateSurvivesAMirrorAndRemovesOnNull() {
        PushSettingsStore s = new PushSettingsStore(new MapKeyValue());
        s.setEngineState("sum:cfg1", "3");
        s.put(4, false, null, null);
        assertEquals("3", s.engineState("sum:cfg1"));
        s.setEngineState("sum:cfg1", null);
        assertNull(s.engineState("sum:cfg1"));
    }
}
