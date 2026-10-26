package ca.erplibre.home;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.EventListener;
import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.Buffer;
import okio.BufferedSink;
import okio.Okio;
import okio.Source;

/**
 * Streamed HTTP file transfer for the chat: a multipart upload read from a
 * file and a download written to a file, neither ever whole in memory. No
 * Capacitor type, so the JVM unit tests drive it against a local server.
 *
 * The client has no CookieJar: the Cookie header the caller gives is sent
 * as given, and a Set-Cookie answer changes nothing. Redirects are not
 * followed: a 3xx is returned to the caller as any other status.
 *
 * A failure before the request headers start out (refused, unknown host,
 * TLS handshake, connect timeout) throws UnsentException: the server saw
 * nothing. A transfer cancelled through cancel(id) throws
 * CancelledException. Any other IOException may come after the server
 * received part or all of the request.
 */
public class ChatFileTransfer {

    /** The request provably never reached the server. */
    public static class UnsentException extends IOException {
        UnsentException(IOException cause) {
            super(cause.getMessage(), cause);
        }
    }

    /** The transfer was stopped by cancel(id). */
    public static class CancelledException extends IOException {
        CancelledException(IOException cause) {
            super("cancelled", cause);
        }
    }

    /** Bytes done so far and the total, -1 when the server sends no length. */
    public interface Progress {
        void onProgress(long done, long total);
    }

    /** A text answer: status, the first value of each header (lowercase names), the body as UTF-8. */
    public static class Answer {
        public final int status;
        public final Map<String, String> headers;
        public final String data;

        Answer(int status, Map<String, String> headers, String data) {
            this.status = status;
            this.headers = headers;
            this.data = data;
        }
    }

    /**
     * A download's outcome. On a 2xx the file is complete at its target,
     * with its size, SHA-1 (hex) and the Content-Type without parameters;
     * any other status writes nothing and leaves sha1 and mimetype null.
     */
    public static class Download {
        public final int status;
        public final long size;
        public final String sha1;
        public final String mimetype;

        Download(int status, long size, String sha1, String mimetype) {
            this.status = status;
            this.size = size;
            this.sha1 = sha1;
            this.mimetype = mimetype;
        }
    }

    /** Set by the call's EventListener once the request headers start out. */
    private static final class Sent {
        volatile boolean value;
    }

    private static final int CHUNK = 64 * 1024;

    /**
     * Write and read timeouts are per socket operation, not per transfer:
     * a large file on a slow link never times out while bytes keep moving.
     * There is no call timeout for the same reason.
     */
    private final OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .readTimeout(300, TimeUnit.SECONDS)
        .callTimeout(0, TimeUnit.SECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .eventListenerFactory(call -> {
            final Sent sent = call.request().tag(Sent.class);
            if (sent == null) return EventListener.NONE;
            return new EventListener() {
                @Override
                public void requestHeadersStart(Call c) {
                    sent.value = true;
                }
            };
        })
        .build();

    /** Calls in flight by transfer id, for cancel(id). */
    private final Map<String, Call> calls = new ConcurrentHashMap<>();

    /**
     * The file a uri names (a file: URI or an absolute path), when it lies
     * strictly inside chatRoot once both are canonical (symbolic links and
     * ".." resolved). Anything else throws SecurityException, so the plugin
     * never reads or writes outside the app's chat directory.
     */
    public static File resolveInside(File chatRoot, String uri) throws IOException {
        if (uri == null || uri.isEmpty()) throw new SecurityException("no path");
        File file;
        if (uri.startsWith("file:")) {
            try {
                file = new File(new URI(uri));
            } catch (Exception e) {
                file = new File(uri.replaceFirst("^file:(//)?", ""));
            }
        } else {
            file = new File(uri);
        }
        String root = chatRoot.getCanonicalPath() + File.separator;
        File canonical = file.getCanonicalFile();
        if (!canonical.getPath().startsWith(root)) {
            throw new SecurityException("path outside the chat directory");
        }
        return canonical;
    }

    /** GET url with the given headers, the answer read as text. */
    public Answer getText(String url, Map<String, String> headers) throws IOException {
        Sent sent = new Sent();
        Request request = request(url, headers, sent).get().build();
        try (Response response = execute(null, request, sent)) {
            return answer(response);
        }
    }

    /**
     * POST url as multipart/form-data: the fields in their map order, then
     * one part "ufile" named `name`, streamed from `file`. Progress counts
     * the file's bytes written to the socket.
     */
    public Answer upload(String id, String url, Map<String, String> headers,
                         Map<String, String> fields, File file, String name,
                         String mimetype, Progress progress) throws IOException {
        MultipartBody.Builder body = new MultipartBody.Builder().setType(MultipartBody.FORM);
        for (Map.Entry<String, String> f : fields.entrySet()) {
            body.addFormDataPart(f.getKey(), f.getValue());
        }
        body.addFormDataPart("ufile", name, new FileBody(file, mimetype, progress));
        Sent sent = new Sent();
        Request request = request(url, headers, sent).post(body.build()).build();
        try (Response response = execute(id, request, sent)) {
            return answer(response);
        } catch (IOException e) {
            throw classify(id, e);
        } finally {
            if (id != null) calls.remove(id);
        }
    }

    /**
     * GET url into `target`. The body streams to `target + ".part"` with
     * its SHA-1 computed on the way, and the part file is renamed onto the
     * target only after the last byte; a non-2xx status, an error or a
     * cancel deletes the part file, so the target is either complete or
     * untouched.
     */
    public Download download(String id, String url, Map<String, String> headers,
                             File target, Progress progress) throws IOException {
        File part = new File(target.getPath() + ".part");
        Sent sent = new Sent();
        Request request = request(url, headers, sent).get().build();
        try (Response response = execute(id, request, sent)) {
            int status = response.code();
            if (status < 200 || status >= 300) {
                part.delete();
                return new Download(status, 0, null, null);
            }
            ResponseBody body = response.body();
            long total = body == null ? -1 : body.contentLength();
            File dir = target.getParentFile();
            if (dir != null && !dir.isDirectory() && !dir.mkdirs()) {
                throw new IOException("cannot create " + dir.getName());
            }
            MessageDigest sha1 = sha1();
            long done = 0;
            try (OutputStream out = new FileOutputStream(part)) {
                if (body != null) {
                    try (InputStream in = body.byteStream()) {
                        byte[] buf = new byte[CHUNK];
                        int n;
                        while ((n = in.read(buf)) != -1) {
                            out.write(buf, 0, n);
                            sha1.update(buf, 0, n);
                            done += n;
                            progress.onProgress(done, total);
                        }
                    }
                }
            }
            if (target.exists() && !target.delete()) {
                throw new IOException("cannot replace " + target.getName());
            }
            if (!part.renameTo(target)) {
                throw new IOException("cannot rename onto " + target.getName());
            }
            return new Download(status, done, hex(sha1.digest()),
                mimetype(response.header("Content-Type")));
        } catch (IOException e) {
            part.delete();
            throw classify(id, e);
        } catch (RuntimeException e) {
            part.delete();
            throw e;
        } finally {
            if (id != null) calls.remove(id);
        }
    }

    /** Cancels the transfer `id` in flight; nothing when none runs under it. */
    public void cancel(String id) {
        Call call = calls.get(id);
        if (call != null) call.cancel();
    }

    private static Request.Builder request(String url, Map<String, String> headers, Sent sent) {
        Request.Builder rb = new Request.Builder().url(url).tag(Sent.class, sent);
        for (Map.Entry<String, String> h : headers.entrySet()) {
            if (h.getValue() != null) rb.header(h.getKey(), h.getValue());
        }
        return rb;
    }

    /** Runs the call registered under id (when given); an early failure becomes UnsentException. */
    private Response execute(String id, Request request, Sent sent) throws IOException {
        Call call = client.newCall(request);
        if (id != null) calls.put(id, call);
        try {
            return call.execute();
        } catch (IOException e) {
            if (call.isCanceled()) throw new CancelledException(e);
            if (!sent.value) throw new UnsentException(e);
            throw e;
        }
    }

    /** A failure after execute() returned: a cancel is told apart, the rest passes as is. */
    private IOException classify(String id, IOException e) {
        if (e instanceof UnsentException || e instanceof CancelledException) return e;
        Call call = id == null ? null : calls.get(id);
        if (call != null && call.isCanceled()) return new CancelledException(e);
        return e;
    }

    private static Answer answer(Response response) throws IOException {
        Map<String, String> headers = new LinkedHashMap<>();
        for (String name : response.headers().names()) {
            headers.put(name.toLowerCase(), response.header(name));
        }
        ResponseBody body = response.body();
        return new Answer(response.code(), headers, body == null ? "" : body.string());
    }

    private static String mimetype(String contentType) {
        if (contentType == null) return null;
        String type = contentType.split(";", 2)[0].trim().toLowerCase();
        return type.isEmpty() ? null : type;
    }

    private static MessageDigest sha1() {
        try {
            return MessageDigest.getInstance("SHA-1");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    /** A file as a request body, read in chunks while it is written out. */
    private static final class FileBody extends RequestBody {
        private final File file;
        private final MediaType type;
        private final Progress progress;

        FileBody(File file, String mimetype, Progress progress) {
            this.file = file;
            MediaType parsed = mimetype == null ? null : MediaType.parse(mimetype);
            this.type = parsed != null ? parsed : MediaType.get("application/octet-stream");
            this.progress = progress;
        }

        @Override
        public MediaType contentType() {
            return type;
        }

        @Override
        public long contentLength() {
            return file.length();
        }

        @Override
        public void writeTo(BufferedSink sink) throws IOException {
            long total = file.length();
            long done = 0;
            try (Source source = Okio.source(file)) {
                Buffer buf = new Buffer();
                long n;
                while ((n = source.read(buf, CHUNK)) != -1) {
                    sink.write(buf, n);
                    done += n;
                    progress.onProgress(done, total);
                }
            }
        }
    }
}
