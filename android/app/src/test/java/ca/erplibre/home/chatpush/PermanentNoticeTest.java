package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

public class PermanentNoticeTest {

    @Test
    public void oneHolderShowsItsLine() {
        PermanentNotice.State s = new PermanentNotice.State();
        s.hold(PermanentNotice.Holder.SMS, "En service");
        assertFalse(s.empty());
        assertEquals("Passerelle SMS ERPLibre", s.title());
        assertEquals(Collections.singletonList("En service"), s.lines());

        PermanentNotice.State c = new PermanentNotice.State();
        c.hold(PermanentNotice.Holder.CHAT, "À l'écoute d'un serveur");
        assertEquals("ERPLibre", c.title());
        assertEquals(Collections.singletonList("À l'écoute d'un serveur"), c.lines());
    }

    @Test
    public void twoHoldersShowOneNotificationWithBothLines() {
        PermanentNotice.State s = new PermanentNotice.State();
        s.hold(PermanentNotice.Holder.CHAT, "À l'écoute de 2 serveurs");
        s.hold(PermanentNotice.Holder.SMS, "3 SMS en attente d'envoi");
        assertEquals("ERPLibre", s.title());
        assertEquals(Arrays.asList("Passerelle SMS : 3 SMS en attente d'envoi", "À l'écoute de 2 serveurs"),
                s.lines());
        s.hold(PermanentNotice.Holder.CHAT, "En attente du réseau");
        assertEquals(Arrays.asList("Passerelle SMS : 3 SMS en attente d'envoi", "En attente du réseau"),
                s.lines());
    }

    @Test
    public void releasingOneWhileTheOtherHoldsNamesTheOtherToReassert() {
        PermanentNotice.State s = new PermanentNotice.State();
        s.hold(PermanentNotice.Holder.SMS, "En service");
        s.hold(PermanentNotice.Holder.CHAT, "Vérification toutes les 15 minutes");
        assertEquals(PermanentNotice.Holder.SMS, s.release(PermanentNotice.Holder.CHAT));
        assertEquals("Passerelle SMS ERPLibre", s.title());
        assertEquals(Collections.singletonList("En service"), s.lines());
        // a holder that does not hold changes nothing and names no one
        assertNull(s.release(PermanentNotice.Holder.CHAT));
        assertEquals(Collections.singletonList("En service"), s.lines());
    }

    @Test
    public void releasingTheLastEmptiesIt() {
        PermanentNotice.State s = new PermanentNotice.State();
        s.hold(PermanentNotice.Holder.CHAT, "En attente du réseau");
        assertNull(s.release(PermanentNotice.Holder.CHAT));
        assertTrue(s.empty());
        assertEquals("", s.title());
        assertTrue(s.lines().isEmpty());
    }

    // ---- a foreground start Android may refuse ----

    @Test
    public void anAcceptedForegroundStartSkipsTheFallback() {
        List<String> log = new ArrayList<>();
        assertNull(PermanentNotice.tryForeground(() -> log.add("start"), () -> log.add("fallback")));
        assertEquals(Collections.singletonList("start"), log);
    }

    @Test
    public void aRefusedForegroundStartRunsTheFallbackAndNamesTheRefusal() {
        List<String> log = new ArrayList<>();
        String refusal = PermanentNotice.tryForeground(() -> {
            // ForegroundServiceStartNotAllowedException is an IllegalStateException
            throw new IllegalStateException("startForeground not allowed");
        }, () -> log.add("fallback"));
        assertEquals("IllegalStateException", refusal);
        assertEquals(Collections.singletonList("fallback"), log);
        assertEquals("IllegalStateException", PermanentNotice.tryForeground(() -> {
            throw new IllegalStateException("refused");
        }, null));
    }

    @Test(expected = SecurityException.class)
    public void anotherFailureOfTheStartIsNotSwallowed() {
        PermanentNotice.tryForeground(() -> {
            throw new SecurityException("missing permission");
        }, null);
    }

    @Test
    public void aFailedHoldIsUndoneByItsRelease() {
        PermanentNotice.State s = new PermanentNotice.State();
        s.hold(PermanentNotice.Holder.SMS, "En service");
        s.hold(PermanentNotice.Holder.CHAT, "En attente du réseau");
        assertEquals(PermanentNotice.Holder.SMS, s.release(PermanentNotice.Holder.CHAT));
        assertEquals(Collections.singletonList("En service"), s.lines());
        assertEquals("Passerelle SMS ERPLibre", s.title());
    }

    @Test
    public void aRefusedHoldLeavesNeitherItsServiceNorItsLine() {
        PermanentNotice.State st = new PermanentNotice.State();
        Map<PermanentNotice.Holder, String> services = new EnumMap<>(PermanentNotice.Holder.class);
        List<String> posts = new ArrayList<>();
        assertNull(PermanentNotice.hold(st, services, "sms", PermanentNotice.Holder.SMS, "En service",
                (s, held) -> posts.add(s + (held ? ":notify" : ":start"))));
        String refusal = PermanentNotice.hold(st, services, "chat", PermanentNotice.Holder.CHAT,
                "En attente du réseau", (s, held) -> {
                    throw new IllegalStateException("startForeground not allowed");
                });
        assertEquals("IllegalStateException", refusal);
        assertEquals(Collections.singletonMap(PermanentNotice.Holder.SMS, "sms"), services);
        assertEquals(Collections.singletonList("En service"), st.lines());
        assertEquals("Passerelle SMS ERPLibre", st.title());
        // the holder that kept the notice only updates its line afterwards
        assertNull(PermanentNotice.hold(st, services, "sms", PermanentNotice.Holder.SMS, "Serveur injoignable…",
                (s, held) -> posts.add(s + (held ? ":notify" : ":start"))));
        assertEquals(Arrays.asList("sms:start", "sms:notify"), posts);
    }
}
