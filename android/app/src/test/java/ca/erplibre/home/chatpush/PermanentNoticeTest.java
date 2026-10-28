package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
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

    // ---- the chat line (R10) ----

    private static AccountView account(String configId, String label) {
        return new AccountView(configId, label, LockScreenMode.ALWAYS, new HashMap<Long, ChannelInfo>());
    }

    private static HealthSnapshot.Ntfy ntfy(String url, String state, String reason, String... ids) {
        return new HealthSnapshot.Ntfy(url, state, reason, 0L, Arrays.asList(ids));
    }

    private static HealthSnapshot.Account acc(String configId, String state, String reason) {
        return new HealthSnapshot.Account(configId, "ntfy", state, reason, 0L);
    }

    private static HealthSnapshot health(String mode, List<HealthSnapshot.Ntfy> ns, List<HealthSnapshot.Account> as) {
        return new HealthSnapshot(1L, 1, 1, mode, true, true, ns, as, 0, 0);
    }

    private static final PushStrings FR = new PushStrings(null);

    @Test
    public void theChatLineCountsTheConnectedServers() {
        List<AccountView> views = Arrays.asList(account("cfg1", "Serveur A"), account("cfg2", "Serveur B"));
        HealthSnapshot one = health("realtime",
                Arrays.asList(ntfy("https://ntfy.exemple.test/", "connected", null, "cfg1", "cfg2")),
                Arrays.asList(acc("cfg1", "ok", null), acc("cfg2", "ok", null)));
        assertEquals("À l'écoute d'un serveur", one.permanentLine(FR, views));
        HealthSnapshot two = health("realtime",
                Arrays.asList(ntfy("https://ntfy.exemple.test/", "connected", null, "cfg1"),
                        ntfy("https://ntfy2.exemple.test/", "connected", null, "cfg2")),
                Arrays.asList(acc("cfg1", "ok", null), acc("cfg2", "ok", null)));
        assertEquals("À l'écoute de 2 serveurs", two.permanentLine(FR, views));
        HealthSnapshot waiting = health("realtime",
                Arrays.asList(ntfy("https://ntfy.exemple.test/", "connecting", null, "cfg1")),
                Arrays.asList(acc("cfg1", "waiting", null)));
        assertEquals("En attente du réseau", waiting.permanentLine(FR, views));
    }

    @Test
    public void theChatLineSaysThePollAndNamesAFailure() {
        List<AccountView> views = Arrays.asList(account("cfg1", "Serveur A"), account("cfg2", "Serveur B"));
        HealthSnapshot poll = health("poll_15",
                Arrays.asList(ntfy("https://ntfy.exemple.test/", "polling", null, "cfg1")),
                Arrays.asList(acc("cfg1", "ok", null)));
        assertEquals("Vérification toutes les 15 minutes", poll.permanentLine(FR, views));
        HealthSnapshot failing = health("realtime",
                Arrays.asList(ntfy("https://ntfy.exemple.test/", "connected", null, "cfg1"),
                        ntfy("https://ntfy2.exemple.test/", "error", "unauthorized", "cfg2")),
                Arrays.asList(acc("cfg1", "ok", null), acc("cfg2", "error", "unauthorized")));
        assertEquals("Serveur B : jeton refusé par ntfy", failing.permanentLine(FR, views));
        Map<String, String> en = new HashMap<>();
        en.put("permanent_failing", "{server}: {reason}");
        en.put("reason_session_expired", "Odoo session expired");
        HealthSnapshot expired = health("realtime",
                Arrays.asList(ntfy("https://ntfy.exemple.test/", "connected", null, "cfg1")),
                Arrays.asList(acc("cfg1", "session_expired", "session_expired")));
        assertEquals("Serveur A: Odoo session expired", expired.permanentLine(new PushStrings(en), views));
    }
}
