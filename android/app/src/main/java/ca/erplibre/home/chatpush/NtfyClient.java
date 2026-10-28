package ca.erplibre.home.chatpush;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

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

    /**
     * Callbacks of a stream. Every one runs on an OkHttp thread, never on the
     * caller's, including the refusal reported when stream() declines to send
     * a request. onClosed comes exactly once, last. It gets null both for a
     * clean end by the server and for a cancel by the caller: a caller that
     * must tell them apart keeps its own "I cancelled" flag.
     */
    interface Listener {
        void onOpen();

        void onMessage(NtfyMessage m);

        void onKeepalive();

        /** The stream ended: cause is null for a clean end or a cancel, the reason otherwise. */
        void onClosed(NtfyException cause);
    }

    private interface EventSink {
        void accept(NtfyMessage m) throws NtfyException;
    }

    private static final Pattern TOPIC = Pattern.compile("[-_A-Za-z0-9]+");

    private final OkHttpClient client;

    NtfyClient(OkHttpClient base) {
        this.client = base.newBuilder().followRedirects(false).followSslRedirects(false).build();
    }

    /**
     * Opens GET &lt;url&gt;/&lt;t1&gt;,&lt;t2&gt;/json?since=&lt;since&gt; and
     * returns at once; events reach the listener as lines arrive, and none
     * after cancel() on the returned call. A null or empty since opens the
     * stream from now. A refusal before any request (policy, bad URL) is
     * reported to the listener from an OkHttp thread, and the returned call
     * is already cancelled, so the caller always has a call to cancel. A
     * listener that throws ends the stream with PROTOCOL.
     */
    Call stream(NtfyServer s, List<String> topics, String since, boolean allowHttp, final Listener l) {
        checkTopics(topics);
        HttpUrl.Builder b = null;
        NtfyException refusal = null;
        if (!HttpPolicy.allowed(s.url, allowHttp)) {
            refusal = new NtfyException(NtfyException.Kind.HTTP_REFUSED);
        } else {
            try {
                b = base(s, topics, "json");
            } catch (NtfyException e) {
                refusal = e;
            }
        }
        if (refusal != null) {
            final NtfyException cause = refusal;
            Call dead = client.newCall(new Request.Builder().url("http://localhost/").build());
            dead.cancel();
            client.dispatcher().executorService().execute(new Runnable() {
                @Override
                public void run() {
                    l.onClosed(cause);
                }
            });
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
            public void onResponse(final Call c, Response r) {
                final boolean[] listenerFailed = {false};
                try (Response resp = r) {
                    if (!resp.isSuccessful()) {
                        l.onClosed(NtfyException.forStatus(resp.code()));
                        return;
                    }
                    readEvents(c, resp.body().source(), new EventSink() {
                        @Override
                        public void accept(NtfyMessage m) throws NtfyException {
                            try {
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
                            } catch (RuntimeException e) {
                                listenerFailed[0] = true;
                                c.cancel();
                                throw new NtfyException(NtfyException.Kind.PROTOCOL, "listener failed", null);
                            }
                        }
                    });
                    l.onClosed(null);
                } catch (NtfyException e) {
                    l.onClosed(listenerFailed[0] || !c.isCanceled() ? e : null);
                } catch (IOException e) {
                    l.onClosed(c.isCanceled() ? null : NtfyException.forIo(e));
                }
            }
        });
        return call;
    }

    /**
     * Reads event lines until the body ends or the call is cancelled. A last
     * line without its newline (a body cut mid-event) is an EOFException, not
     * an event.
     */
    private static void readEvents(Call c, BufferedSource src, EventSink sink) throws IOException, NtfyException {
        while (!c.isCanceled() && !src.exhausted()) {
            String line = src.readUtf8LineStrict();
            if (line.isEmpty()) continue;
            sink.accept(NtfyMessage.parse(line));
        }
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
        final List<NtfyMessage> out = new ArrayList<>();
        final Call call = client.newCall(request(s, url));
        try (Response r = call.execute()) {
            if (!r.isSuccessful()) throw NtfyException.forStatus(r.code());
            readEvents(call, r.body().source(), new EventSink() {
                @Override
                public void accept(NtfyMessage m) {
                    if ("message".equals(m.event)) out.add(m);
                }
            });
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
        checkTopics(one);
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
        for (String t : topics) {
            if (t == null || !TOPIC.matcher(t).matches()) throw new IllegalArgumentException("bad topic");
        }
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
