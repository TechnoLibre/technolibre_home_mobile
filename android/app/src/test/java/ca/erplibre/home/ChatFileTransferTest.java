package ca.erplibre.home;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.util.Arrays;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import okhttp3.MediaType;
import okhttp3.MultipartReader;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import okhttp3.mockwebserver.SocketPolicy;
import okio.Buffer;

import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class ChatFileTransferTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private MockWebServer server;
    private ChatFileTransfer transfer;
    private File chatRoot;

    @Before
    public void setUp() throws IOException {
        server = new MockWebServer();
        server.start();
        transfer = new ChatFileTransfer();
        chatRoot = tmp.newFolder("files", "chat");
    }

    @After
    public void tearDown() throws IOException {
        server.shutdown();
    }

    private static byte[] sample(int size) {
        byte[] bytes = new byte[size];
        for (int i = 0; i < size; i++) bytes[i] = (byte) (i * 31 + 7);
        return bytes;
    }

    private File writeFile(String rel, byte[] bytes) throws IOException {
        File f = new File(chatRoot, rel);
        f.getParentFile().mkdirs();
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(bytes);
        }
        return f;
    }

    private static String sha1Hex(byte[] bytes) throws Exception {
        StringBuilder sb = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-1").digest(bytes)) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    private static Map<String, String> headers(String... pairs) {
        Map<String, String> m = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) m.put(pairs[i], pairs[i + 1]);
        return m;
    }

    @Test
    public void uploadStreamsFieldsThenTheFileAsUfile() throws Exception {
        byte[] bytes = sample(300_000);
        File file = writeFile("d1/out/u1/photo.jpg", bytes);
        server.enqueue(new MockResponse().setBody("{\"data\":{}}")
            .setHeader("Content-Type", "application/json"));

        Map<String, String> fields = headers(
            "thread_id", "12", "thread_model", "discuss.channel",
            "is_pending", "true", "csrf_token", "tok0o1");
        List<long[]> progress = new ArrayList<>();
        ChatFileTransfer.Answer answer = transfer.upload(transfer.reserve("a1"),
            server.url("/mail/attachment/upload").toString(),
            headers("Cookie", "session_id=s1"), fields, file, "photo.jpg",
            "image/jpeg", (done, total) -> progress.add(new long[] {done, total}));

        assertEquals(200, answer.status);
        assertEquals("{\"data\":{}}", answer.data);
        assertEquals("application/json", answer.headers.get("content-type"));

        RecordedRequest req = server.takeRequest();
        assertEquals("POST", req.getMethod());
        String boundary = MediaType.parse(req.getHeader("Content-Type")).parameter("boundary");
        Buffer body = req.getBody();
        List<String> names = new ArrayList<>();
        byte[] uploaded = null;
        String filename = null;
        try (MultipartReader reader = new MultipartReader(body, boundary)) {
            MultipartReader.Part part;
            while ((part = reader.nextPart()) != null) {
                String disposition = part.headers().get("Content-Disposition");
                String name = disposition.replaceAll(".*\\bname=\"([^\"]*)\".*", "$1");
                names.add(name);
                if (name.equals("ufile")) {
                    filename = disposition.replaceAll(".*filename=\"([^\"]*)\".*", "$1");
                    uploaded = part.body().readByteArray();
                } else {
                    assertEquals(fields.get(name), part.body().readUtf8());
                }
            }
        }
        List<String> expected = new ArrayList<>(fields.keySet());
        expected.add("ufile");
        assertEquals(expected, names);
        assertEquals("photo.jpg", filename);
        assertArrayEquals(bytes, uploaded);
        assertFalse(progress.isEmpty());
        long[] last = progress.get(progress.size() - 1);
        assertEquals(bytes.length, last[0]);
        assertEquals(bytes.length, last[1]);
    }

    @Test
    public void explicitCookieHeaderReachesTheServer() throws Exception {
        server.enqueue(new MockResponse().setBody("<html></html>"));
        ChatFileTransfer.Answer answer = transfer.getText(
            server.url("/web/login").toString(), headers("Cookie", "session_id=abc123"));
        assertEquals(200, answer.status);
        assertEquals("<html></html>", answer.data);
        RecordedRequest req = server.takeRequest();
        assertEquals("GET", req.getMethod());
        assertEquals("session_id=abc123", req.getHeader("Cookie"));
    }

    @Test
    public void redirectIsReturnedNotFollowed() throws Exception {
        server.enqueue(new MockResponse().setResponseCode(303).setHeader("Location", "/odoo"));
        ChatFileTransfer.Answer answer = transfer.getText(server.url("/web/login").toString(), headers());
        assertEquals(303, answer.status);
        assertEquals(1, server.getRequestCount());
    }

    @Test
    public void downloadWritesThenRenamesAndReportsSha1() throws Exception {
        byte[] bytes = sample(200_000);
        server.enqueue(new MockResponse().setBody(new Buffer().write(bytes))
            .setHeader("Content-Type", "image/png; charset=binary"));
        File target = new File(chatRoot, "d1/files/7/a.png");

        ChatFileTransfer.Download d = transfer.download(transfer.reserve("d1"),
            server.url("/web/content/7").toString(), headers("Cookie", "session_id=s1"),
            target, (done, total) -> {});

        assertEquals(200, d.status);
        assertEquals(bytes.length, d.size);
        assertEquals(sha1Hex(bytes), d.sha1);
        assertEquals("image/png", d.mimetype);
        assertTrue(target.isFile());
        assertFalse(new File(target.getPath() + ".part").exists());
        assertArrayEquals(bytes, java.nio.file.Files.readAllBytes(target.toPath()));
        assertEquals("session_id=s1", server.takeRequest().getHeader("Cookie"));
    }

    @Test
    public void downloadFailureLeavesNoPartFile() throws Exception {
        File target = new File(chatRoot, "d1/files/8/b.bin");

        server.enqueue(new MockResponse().setResponseCode(500).setBody("boom"));
        ChatFileTransfer.Download d = transfer.download(transfer.reserve("d2"),
            server.url("/web/content/8").toString(), headers(), target, (done, total) -> {});
        assertEquals(500, d.status);
        assertNull(d.sha1);
        assertFalse(target.exists());
        assertFalse(new File(target.getPath() + ".part").exists());

        server.enqueue(new MockResponse().setBody(new Buffer().write(sample(500_000)))
            .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY));
        try {
            transfer.download(transfer.reserve("d3"), server.url("/web/content/8").toString(), headers(),
                target, (done, total) -> {});
            fail("a body cut short must fail");
        } catch (IOException expected) {
            assertFalse(expected instanceof ChatFileTransfer.UnsentException);
        }
        assertFalse(target.exists());
        assertFalse(new File(target.getPath() + ".part").exists());
    }

    @Test
    public void connectionRefusedIsUnsent() throws Exception {
        int port;
        try (ServerSocket s = new ServerSocket(0)) {
            port = s.getLocalPort();
        }
        File file = writeFile("d1/out/u2/a.txt", sample(10));
        try {
            transfer.upload(transfer.reserve("u2"), "http://127.0.0.1:" + port + "/mail/attachment/upload",
                headers(), headers("thread_id", "1"), file, "a.txt", "text/plain",
                (done, total) -> {});
            fail("a refused connection must fail");
        } catch (ChatFileTransfer.UnsentException expected) {
            // nothing reached the server
        }
    }

    @Test
    public void anUploadCutAfterTheServerReadItIsNotSentAgain() throws Exception {
        File file = writeFile("d1/out/u3/a.bin", sample(50_000));
        // A first answer leaves a pooled connection: a failure on a reused
        // connection is the case a retrying client sends again on a new one
        server.enqueue(new MockResponse().setBody("<html></html>"));
        assertEquals(200, transfer.getText(server.url("/web/login").toString(), headers()).status);
        server.enqueue(new MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST));
        server.enqueue(new MockResponse().setBody("{\"data\":{}}"));
        try {
            transfer.upload(transfer.reserve("u3"), server.url("/mail/attachment/upload").toString(), headers(),
                headers("thread_id", "1"), file, "a.bin", "application/octet-stream", (d, t) -> {});
            fail("a connection cut after the request must fail");
        } catch (IOException expected) {
            assertFalse(expected instanceof ChatFileTransfer.UnsentException);
        }
        assertEquals(2, server.getRequestCount());
    }

    @Test
    public void cancelStopsADownloadAndLeavesNoPartFile() throws Exception {
        server.enqueue(new MockResponse().setBody(new Buffer().write(sample(2_000_000)))
            .throttleBody(64 * 1024, 50, TimeUnit.MILLISECONDS));
        File target = new File(chatRoot, "d1/files/9/c.bin");
        CountDownLatch started = new CountDownLatch(1);
        AtomicReference<Throwable> outcome = new AtomicReference<>();
        Thread t = new Thread(() -> {
            try {
                transfer.download(transfer.reserve("c1"), server.url("/web/content/9").toString(), headers(), target,
                    (done, total) -> started.countDown());
            } catch (Throwable e) {
                outcome.set(e);
            }
        });
        t.start();
        assertTrue(started.await(10, TimeUnit.SECONDS));
        transfer.cancel("c1");
        t.join(10_000);
        assertTrue(outcome.get() instanceof ChatFileTransfer.CancelledException);
        assertFalse(target.exists());
        assertFalse(new File(target.getPath() + ".part").exists());
    }

    @Test
    public void aCancelBeforeTheCallIsRegisteredStillCancelsIt() throws Exception {
        File file = writeFile("d1/out/u4/a.txt", sample(10));
        ChatFileTransfer.Slot slot = transfer.reserve("u4");
        transfer.cancel("u4");
        try {
            transfer.upload(slot, server.url("/mail/attachment/upload").toString(), headers(),
                headers("thread_id", "1"), file, "a.txt", "text/plain", (d, t) -> {});
            fail("a reserved transfer cancelled before it starts must not run");
        } catch (ChatFileTransfer.CancelledException expected) {
            // never sent
        } finally {
            transfer.release(slot);
        }
        assertEquals(0, server.getRequestCount());
        // The tombstone ends with its transfer: the same id runs again
        server.enqueue(new MockResponse().setBody("ok"));
        assertEquals(200, transfer.upload(transfer.reserve("u4"), server.url("/mail/attachment/upload").toString(),
            headers(), headers("thread_id", "1"), file, "a.txt", "text/plain", (d, t) -> {}).status);
    }

    @Test
    public void aCancelOfNoTransferLeavesNoTombstone() throws Exception {
        transfer.cancel("u5");
        server.enqueue(new MockResponse().setBody("ok"));
        File file = writeFile("d1/out/u5/a.txt", sample(10));
        assertEquals(200, transfer.upload(transfer.reserve("u5"), server.url("/mail/attachment/upload").toString(),
            headers(), headers("thread_id", "1"), file, "a.txt", "text/plain", (d, t) -> {}).status);
    }

    @Test
    public void anIdHeldByATransferIsRefused() throws Exception {
        ChatFileTransfer.Slot slot = transfer.reserve("u6");
        try {
            transfer.reserve("u6");
            fail("two transfers under one id");
        } catch (ChatFileTransfer.IdInUseException expected) {
            // ids are unique per transfer
        }
        transfer.release(slot);
        transfer.release(transfer.reserve("u6"));
    }

    @Test
    public void aDeadFirstAddressFallsBackToTheNextOne() throws Exception {
        // 127.0.0.2 is loopback with nothing listening on the server's port: refused at once
        InetAddress dead = InetAddress.getByName("127.0.0.2");
        InetAddress live = InetAddress.getByName(server.getHostName());
        ChatFileTransfer twoAddresses = new ChatFileTransfer(host -> Arrays.asList(dead, live));
        String base = "http://files.test:" + server.getPort();
        File file = writeFile("d1/out/u7/a.bin", sample(1000));

        server.enqueue(new MockResponse().setBody("{\"data\":{}}"));
        assertEquals(200, twoAddresses.upload(twoAddresses.reserve("u7"), base + "/mail/attachment/upload",
            headers(), headers("thread_id", "1"), file, "a.bin", "application/octet-stream",
            (d, t) -> {}).status);

        byte[] bytes = sample(3000);
        server.enqueue(new MockResponse().setBody(new Buffer().write(bytes)));
        File target = new File(chatRoot, "d1/files/7/a.bin");
        ChatFileTransfer.Download d = twoAddresses.download(twoAddresses.reserve("d7"),
            base + "/web/content/7", headers(), target, (done, total) -> {});
        assertEquals(200, d.status);
        assertEquals(sha1Hex(bytes), d.sha1);
        assertEquals(2, server.getRequestCount());
    }

    @Test
    public void aGetOnAPooledConnectionTheServerClosedIsSentAgain() throws Exception {
        server.enqueue(new MockResponse().setBody("one").setSocketPolicy(SocketPolicy.DISCONNECT_AT_END));
        server.enqueue(new MockResponse().setBody("two"));
        assertEquals("one", transfer.getText(server.url("/web/login").toString(), headers()).data);
        Thread.sleep(300);
        assertEquals("two", transfer.getText(server.url("/web/login").toString(), headers()).data);
    }

    @Test
    public void pathOutsideTheChatRootIsRefused() throws Exception {
        File inside = ChatFileTransfer.resolveInside(chatRoot,
            new File(chatRoot, "d1/out/u1/a b.txt").toURI().toString());
        assertEquals(new File(chatRoot, "d1/out/u1/a b.txt").getCanonicalPath(), inside.getPath());
        String[] outside = {
            chatRoot.getPath() + "/../secret.db",
            "file://" + chatRoot.getPath() + "/d1/../../secret.db",
            chatRoot.getPath(),
            chatRoot.getPath() + "-other/x",
            "/etc/passwd",
        };
        for (String uri : outside) {
            try {
                ChatFileTransfer.resolveInside(chatRoot, uri);
                fail("refused: " + uri);
            } catch (SecurityException expected) {
                // outside filesDir/chat
            }
        }
    }
}
