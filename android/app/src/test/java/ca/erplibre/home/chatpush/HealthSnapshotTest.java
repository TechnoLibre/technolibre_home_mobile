package ca.erplibre.home.chatpush;

import static org.junit.Assert.assertEquals;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

/** HealthSnapshot.permanentLine: the chat line of the permanent notification (R10). */
public class HealthSnapshotTest {

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
