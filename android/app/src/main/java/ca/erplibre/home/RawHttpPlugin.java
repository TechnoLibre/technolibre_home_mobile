package ca.erplibre.home;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.CookieHandler;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLPeerUnverifiedException;

/**
 * Minimal HTTP POST plugin that bypasses Capacitor's CookieHandler.
 *
 * Problem: CapacitorCookies installs a CookieHandler via
 * CookieHandler.setDefault(). Android's HttpURLConnection calls
 * handler.get() to retrieve cookies before every request. For HTTP
 * connections to IP addresses, WebKit's cookie store is empty, so
 * handler.get() returns nothing — and in the process Android replaces
 * our manually-set Cookie header with an empty value (session_expired).
 *
 * Fix: temporarily set CookieHandler.setDefault(null) so that
 * HttpURLConnection ignores all cookie management and our explicit
 * Cookie header passes through untouched.
 */
@CapacitorPlugin(name = "RawHttp")
public class RawHttpPlugin extends Plugin {

    /**
     * Computes the SHA-256 fingerprint of a certificate's public key (SPKI).
     */
    private static String sha256Fingerprint(X509Certificate cert) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest(cert.getPublicKey().getEncoded());
        StringBuilder sb = new StringBuilder();
        for (byte b : hash) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    /**
     * Verifies that the HTTPS connection's leaf certificate matches the expected pin.
     * @throws SecurityException if the pin doesn't match.
     */
    private void verifyCertificatePin(HttpsURLConnection httpsConn, String expectedPin)
            throws SSLPeerUnverifiedException, Exception {
        Certificate[] certs = httpsConn.getServerCertificates();
        if (certs.length == 0) {
            throw new SecurityException("No server certificates presented");
        }
        X509Certificate leaf = (X509Certificate) certs[0];
        String actualPin = sha256Fingerprint(leaf);
        if (!actualPin.equalsIgnoreCase(expectedPin)) {
            throw new SecurityException(
                "Certificate pin mismatch — possible MITM attack. "
                + "Expected: " + expectedPin.substring(0, 16) + "… "
                + "Got: " + actualPin.substring(0, 16) + "…"
            );
        }
    }

    /**
     * Returns the SHA-256 fingerprint of a server's leaf certificate.
     * Used to establish the pin on first connection.
     */
    @PluginMethod
    public void getCertificatePin(PluginCall call) {
        String urlStr = call.getString("url");
        if (urlStr == null || urlStr.isEmpty()) {
            call.reject("url is required");
            return;
        }

        new Thread(() -> {
            HttpsURLConnection conn = null;
            try {
                URL url = new URL(urlStr);
                conn = (HttpsURLConnection) url.openConnection();
                conn.setConnectTimeout(10000);
                conn.connect();

                Certificate[] certs = conn.getServerCertificates();
                if (certs.length == 0) {
                    call.reject("No server certificates");
                    return;
                }
                X509Certificate leaf = (X509Certificate) certs[0];
                JSObject result = new JSObject();
                result.put("pin", sha256Fingerprint(leaf));
                result.put("subject", leaf.getSubjectX500Principal().getName());
                result.put("issuer", leaf.getIssuerX500Principal().getName());
                result.put("expires", leaf.getNotAfter().toInstant().toString());
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Failed to get certificate: " + e.getMessage(), e);
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    @PluginMethod
    public void post(PluginCall call) {
        String urlStr = call.getString("url");
        JSObject headers = call.getObject("headers", new JSObject());
        String body = call.getString("body", "");
        String certPin = call.getString("certPin", null);

        if (urlStr == null || urlStr.isEmpty()) {
            call.reject("url is required");
            return;
        }

        // Temporarily disable the global CookieHandler so that our explicit
        // Cookie request header is not overwritten by the cookie machinery.
        CookieHandler savedHandler = CookieHandler.getDefault();
        CookieHandler.setDefault(null);

        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(30000);
            conn.setReadTimeout(30000);

            // Apply caller-supplied headers (includes Cookie: session_id=…)
            if (headers != null) {
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    conn.setRequestProperty(key, headers.getString(key));
                }
            }

            // Send body
            byte[] bodyBytes = (body != null ? body : "").getBytes("UTF-8");
            conn.setFixedLengthStreamingMode(bodyBytes.length);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(bodyBytes);
            }

            // Verify certificate pin if provided (before reading response)
            if (certPin != null && !certPin.isEmpty() && conn instanceof HttpsURLConnection) {
                verifyCertificatePin((HttpsURLConnection) conn, certPin);
            }

            // Read response
            int status = conn.getResponseCode();
            java.io.InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            StringBuilder sb = new StringBuilder();
            if (stream != null) {
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, "UTF-8"))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        sb.append(line).append('\n');
                    }
                }
            }

            // Collect response headers
            JSObject respHeaders = new JSObject();
            for (Map.Entry<String, List<String>> entry : conn.getHeaderFields().entrySet()) {
                if (entry.getKey() != null && entry.getValue() != null && !entry.getValue().isEmpty()) {
                    respHeaders.put(entry.getKey().toLowerCase(), entry.getValue().get(0));
                }
            }

            JSObject result = new JSObject();
            result.put("status", status);
            result.put("headers", respHeaders);
            result.put("data", sb.toString().trim());
            call.resolve(result);

        } catch (Exception e) {
            call.reject("RawHttp error: " + e.getMessage(), e);
        } finally {
            if (conn != null) conn.disconnect();
            CookieHandler.setDefault(savedHandler); // Always restore
        }
    }
}
