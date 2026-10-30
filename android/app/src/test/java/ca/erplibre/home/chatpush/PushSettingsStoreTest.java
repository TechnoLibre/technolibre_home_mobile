package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONObject;
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
        s.put(1, true, null, Collections.singletonMap("new_message", "New message"), Collections.singletonList(a));
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
    public void theModuleLevelRoundTripsAndDefaultsToNone() {
        MapKeyValue kv = new MapKeyValue();
        PushSettingsStore s = new PushSettingsStore(kv);
        AccountView with = new AccountView("cfg1", "Odoo exemple", LockScreenMode.ALWAYS, null, "1.5");
        AccountView without = new AccountView("cfg2", "Odoo exemple", LockScreenMode.ALWAYS, null);
        s.put(1, false, null, null, java.util.Arrays.asList(with, without));
        PushSettingsStore again = new PushSettingsStore(kv);
        assertEquals("1.5", again.account("cfg1").module);
        assertEquals("", again.account("cfg2").module);
    }

    @Test
    public void thePhonePrefsRoundTrip() {
        MapKeyValue kv = new MapKeyValue();
        PushSettingsStore s = new PushSettingsStore(kv);
        AccountView.AccountPrefs p = new AccountView.AccountPrefs(PhoneFilter.MENTIONS_DM, false, true,
                true, 1380, 360, "no_notif");
        AccountView a = new AccountView("cfg1", "Odoo exemple", LockScreenMode.ALWAYS, null, "1.6", p);
        s.put(2, false, new PhonePrefs(false, 20, 0, BrowserMode.QUIET), null, Collections.singletonList(a));
        PushSettingsStore again = new PushSettingsStore(kv);
        PhonePrefs prefs = again.prefs();
        assertFalse(prefs.climbAuto);
        assertEquals(20, prefs.oneBelow);
        assertEquals(0, prefs.twoBelow);
        assertEquals(BrowserMode.QUIET, prefs.browserMode);
        AccountView b = again.account("cfg1");
        assertEquals("1.6", b.module);
        assertEquals(PhoneFilter.MENTIONS_DM, b.filter);
        assertFalse(b.inbox);
        assertTrue(b.inboxMentions);
        assertTrue(b.quietOn);
        assertEquals(1380, b.quietFrom);
        assertEquals(360, b.quietTo);
        assertEquals("no_notif", b.channelNotifications);
    }

    @Test
    public void aLot2StoreReadsTheDefaultPrefsAndAccountPrefs() {
        MapKeyValue kv = new MapKeyValue();
        kv.put("level", "3");
        kv.put("accounts", "[{\"configId\":\"cfg1\",\"label\":\"Odoo exemple\",\"lockScreen\":\"always\","
                + "\"channels\":{\"4\":{\"name\":\"MS Chat\",\"type\":\"chat\"}},\"module\":\"1.5\"}]");
        PushSettingsStore s = new PushSettingsStore(kv);
        PhonePrefs prefs = s.prefs();
        assertTrue(prefs.climbAuto);
        assertEquals(30, prefs.oneBelow);
        assertEquals(15, prefs.twoBelow);
        assertEquals(BrowserMode.WAIT, prefs.browserMode);
        AccountView a = s.account("cfg1");
        assertEquals("1.5", a.module);
        assertEquals("chat", a.channels.get(4L).type);
        assertEquals(PhoneFilter.ALL, a.filter);
        assertTrue(a.inbox);
        assertFalse(a.inboxMentions);
        assertFalse(a.quietOn);
        assertEquals(1320, a.quietFrom);
        assertEquals(420, a.quietTo);
        assertNull(a.channelNotifications);
        AccountView four = new AccountView("cfg2", "Odoo exemple", LockScreenMode.ALWAYS, null);
        assertEquals(PhoneFilter.ALL, four.filter);
        assertTrue(four.inbox);
        assertNull(four.channelNotifications);
    }

    @Test
    public void anUnknownFilterOrThresholdReadsAsItsDefault() throws Exception {
        MapKeyValue kv = new MapKeyValue();
        kv.put("prefs", "{\"climb\":{\"auto\":false,\"oneBelow\":25,\"twoBelow\":-1},\"browserMode\":\"loud\"}");
        kv.put("accounts", "[{\"configId\":\"cfg1\",\"filter\":\"loud\",\"inbox\":false,"
                + "\"quiet\":{\"on\":true,\"from\":1440,\"to\":-5},\"channelNotifications\":\"loud\"}]");
        PushSettingsStore s = new PushSettingsStore(kv);
        PhonePrefs prefs = s.prefs();
        assertFalse(prefs.climbAuto);
        assertEquals(30, prefs.oneBelow);
        assertEquals(15, prefs.twoBelow);
        assertEquals(BrowserMode.WAIT, prefs.browserMode);
        AccountView a = s.account("cfg1");
        assertEquals(PhoneFilter.ALL, a.filter);
        assertFalse(a.inbox);
        assertTrue(a.quietOn);
        assertEquals(1320, a.quietFrom);
        assertEquals(420, a.quietTo);
        assertNull(a.channelNotifications);
        assertEquals(PhoneFilter.ALL, PhoneFilter.fromKey(null));
        assertEquals(BrowserMode.WAIT, BrowserMode.fromKey(null));
        PhonePrefs mirror = PhonePrefs.of(new JSONObject("{\"climb\":{\"oneBelow\":40,\"twoBelow\":\"x\"},"
                + "\"browserMode\":\"ring\"}"));
        assertTrue(mirror.climbAuto);
        assertEquals(40, mirror.oneBelow);
        assertEquals(15, mirror.twoBelow);
        assertEquals(BrowserMode.RING, mirror.browserMode);
        assertEquals(PhonePrefs.DEFAULT.browserMode, PhonePrefs.of(null).browserMode);
        kv.put("prefs", "not json");
        assertEquals(30, s.prefs().oneBelow);
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
        s.put(4, false, null, null, null);
        assertEquals("3", s.engineState("sum:cfg1"));
        s.setEngineState("sum:cfg1", null);
        assertNull(s.engineState("sum:cfg1"));
    }

    @Test
    public void theForegroundFlagHoldsOnlyForTheProcessThatSetIt() {
        MapKeyValue kv = new MapKeyValue();
        PushSettingsStore first = new PushSettingsStore(kv, () -> "p1");
        first.setForeground(true);
        assertTrue(first.foreground());
        assertTrue(new PushSettingsStore(kv, () -> "p1").foreground());
        // a later process reads the flag a dead one left as background
        assertFalse(new PushSettingsStore(kv, () -> "p2").foreground());
        first.setForeground(false);
        assertFalse(first.foreground());
        assertNull(kv.get("foreground"));
    }

    @Test
    public void anOldTrueFlagReadsAsBackground() {
        MapKeyValue kv = new MapKeyValue();
        kv.put("foreground", "true");
        assertFalse(new PushSettingsStore(kv, () -> "p1").foreground());
    }

    @Test
    public void storesOfOneProcessShareItsIdentity() {
        MapKeyValue kv = new MapKeyValue();
        new PushSettingsStore(kv).setForeground(true);
        assertTrue(new PushSettingsStore(kv).foreground());
    }
}
