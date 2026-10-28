package ca.erplibre.home.chatpush;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.BufferedSource;

/**
 * Native client of ntfy's /json API: a live stream of several topics, a
 * one-shot poll from a cursor, and a read-right check. Capacitor-free.
 *
 * Every call carries the server's bearer token, follows no redirect (a
 * redirect could leave https), checks the cleartext policy before any
 * request, and reports failures as NtfyException kinds that never contain
 * the token or the URL.
 */
final class NtfyClient {

    /** ntfy refuses a subscription of more topics than this (server.go, 150 distinct topics). */
    static final int MAX_TOPICS = 150;

    /**
     * Longest silence the stream tolerates. ntfy's keepalive is the server's
     * (45 s by default, up to about 100 s when an operator raises it), so
     * the read timeout covers it with room.
     */
    static final int STREAM_READ_TIMEOUT_SECONDS = 120;

    /** Callbacks of a stream, all on OkHttp's thread. */
    interface Listener {
        void onOpen();

        void onMessage(NtfyMessage m);

        void onKeepalive();

        /** The stream ended: cause is null for a clean end or a cancel, the reason otherwise. */
        void onClosed(NtfyException cause);
    }

    private final OkHttpClient client;

    NtfyClient(OkHttpClient base) {
        this.client = base.newBuilder().followRedirects(false).followSslRedirects(false).build();
    }

    /**
     * Opens GET &lt;url&gt;/&lt;t1&gt;,&lt;t2&gt;/json?since=&lt;since&gt; and
     * returns at once; events reach the listener as lines arrive. A null or
     * empty since opens the stream from now. A refused policy reports
     * HTTP_REFUSED to the listener and returns an already cancelled call,
     * so the caller always has a call to cancel.
     */
    Call stream(NtfyServer s, List<String> topics, String since, boolean allowHttp, final Listener l) {
        checkTopics(topics);
        if (!HttpPolicy.allowed(s.url, allowHttp)) {
            Call dead = client.newCall(new Request.Builder().url("http://localhost/").build());
            dead.cancel();
            l.onClosed(new NtfyException(NtfyException.Kind.HTTP_REFUSED));
            return dead;
        }
        HttpUrl.Builder b;
        try {
            b = base(s, topics, "json");
        } catch (NtfyException e) {
            Call dead = client.newCall(new Request.Builder().url("http://localhost/").build());
            dead.cancel();
            l.onClosed(e);
            return dead;
        }
        if (since != null && !since.isEmpty()) b.addQueryParameter("since", since);
        OkHttpClient streaming = client.newBuilder()
                .readTimeout(STREAM_READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .build();
        final Call call = streaming.newCall(request(s, b.build()));
        call.enqueue(new Callback() {
            @Override
            public void onFailure(Call c, IOException e) {
                l.onClosed(c.isCanceled() ? null : NtfyException.forIo(e));
            }

            @Override
            public void onResponse(Call c, Response r) {
                try (Response resp = r) {
                    if (!resp.isSuccessful()) {
                        l.onClosed(NtfyException.forStatus(resp.code()));
                        return;
                    }
                    ResponseBody body = resp.body();
                    BufferedSource src = body.source();
                    String line;
                    while ((line = src.readUtf8Line()) != null) {
                        if (line.isEmpty()) continue;
                        NtfyMessage m = NtfyMessage.parse(line);
                        switch (m.event) {
                            case "open":
                                l.onOpen();
                                break;
                            case "keepalive":
                                l.onKeepalive();
                                break;
                            case "message":
                                l.onMessage(m);
                                break;
                            default:
                                break;
                        }
                    }
                    l.onClosed(null);
                } catch (NtfyException e) {
                    l.onClosed(e);
                } catch (IOException e) {
                    l.onClosed(c.isCanceled() ? null : NtfyException.forIo(e));
                }
            }
        });
        return call;
    }

    /**
     * One-shot GET &lt;url&gt;/&lt;topics&gt;/json?poll=1&amp;since=&lt;since&gt;,
     * the "message" events in server order. since is required: a poll without
     * it returns the whole cache. Replays may repeat messages; drop them with
     * SeenIds.
     */
    List<NtfyMessage> poll(NtfyServer s, List<String> topics, String since, boolean allowHttp) throws NtfyException {
        checkTopics(topics);
        if (since == null || since.isEmpty()) throw new IllegalArgumentException("since is required");
        checkPolicy(s, allowHttp);
        HttpUrl url = base(s, topics, "json").addQueryParameter("poll", "1").addQueryParameter("since", since).build();
        List<NtfyMessage> out = new ArrayList<>();
        try (Response r = client.newCall(request(s, url)).execute()) {
            if (!r.isSuccessful()) throw NtfyException.forStatus(r.code());
            BufferedSource src = r.body().source();
            String line;
            while ((line = src.readUtf8Line()) != null) {
                if (line.isEmpty()) continue;
                NtfyMessage m = NtfyMessage.parse(line);
                if ("message".equals(m.event)) out.add(m);
            }
        } catch (IOException e) {
            throw NtfyException.forIo(e);
        }
        return out;
    }

    /** GET &lt;url&gt;/&lt;topic&gt;/auth: returns when the token may read the topic, throws the kind otherwise. */
    void checkRead(NtfyServer s, String topic, boolean allowHttp) throws NtfyException {
        checkPolicy(s, allowHttp);
        List<String> one = new ArrayList<>();
        one.add(topic);
        HttpUrl url = base(s, one, "auth").build();
        try (Response r = client.newCall(request(s, url)).execute()) {
            if (!r.isSuccessful()) throw NtfyException.forStatus(r.code());
        } catch (IOException e) {
            throw NtfyException.forIo(e);
        }
    }

    private static void checkTopics(List<String> topics) {
        if (topics == null || topics.isEmpty()) throw new IllegalArgumentException("no topic");
        if (topics.size() > MAX_TOPICS) throw new IllegalArgumentException("more than " + MAX_TOPICS + " topics");
    }

    private static void checkPolicy(NtfyServer s, boolean allowHttp) throws NtfyException {
        if (!HttpPolicy.allowed(s.url, allowHttp)) throw new NtfyException(NtfyException.Kind.HTTP_REFUSED);
    }

    private static HttpUrl.Builder base(NtfyServer s, List<String> topics, String last) throws NtfyException {
        HttpUrl url = HttpUrl.parse(s.url + "/" + String.join(",", topics) + "/" + last);
        if (url == null) throw new NtfyException(NtfyException.Kind.PROTOCOL, "bad server url", null);
        return url.newBuilder();
    }

    private static Request request(NtfyServer s, HttpUrl url) {
        Request.Builder b = new Request.Builder().url(url).get();
        if (s.token != null && !s.token.isEmpty()) b.header("Authorization", "Bearer " + s.token);
        return b.build();
    }
}
