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
import java.util.Iterator;
import java.util.List;
import java.util.Map;

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

    @PluginMethod
    public void post(PluginCall call) {
        String urlStr = call.getString("url");
        JSObject headers = call.getObject("headers", new JSObject());
        String body = call.getString("body", "");

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
