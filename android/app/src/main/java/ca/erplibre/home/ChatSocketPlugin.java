package ca.erplibre.home;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Native websocket for the Odoo bus. A WebView WebSocket cannot set the
 * session Cookie or the server's own Origin, which the bus checks; OkHttp
 * sends both from the headers of the call.
 *
 * One socket per id (the account's configId). Events carry the id:
 * chatSocketOpen {id}, chatSocketMessage {id, text},
 * chatSocketClose {id, code, reason}. A socket replaced or closed by the
 * app emits nothing further: every callback first checks that its socket is
 * still the one registered under its id.
 */
@CapacitorPlugin(name = "ChatSocket")
public class ChatSocketPlugin extends Plugin {

    /**
     * Shared client. readTimeout(0) keeps an idle websocket open: a read
     * timeout would kill a quiet bus, so liveness rests on the 30 s
     * ping/pong, which fails the socket when a pong does not come back.
     */
    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .build();

    private final Map<String, WebSocket> sockets = new ConcurrentHashMap<>();

    @PluginMethod
    public void open(PluginCall call) {
        final String id = call.getString("id");
        String url = call.getString("url");
        if (id == null || id.isEmpty() || url == null || url.isEmpty()) {
            call.reject("id and url are required");
            return;
        }
        JSObject headers = call.getObject("headers", new JSObject());

        WebSocket previous = sockets.remove(id);
        if (previous != null) previous.cancel();

        Request.Builder rb;
        try {
            rb = new Request.Builder().url(url);
            if (headers != null) {
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    rb.header(key, headers.getString(key));
                }
            }
        } catch (IllegalArgumentException e) {
            call.reject("Invalid request: " + e.getMessage());
            return;
        }

        WebSocket ws = CLIENT.newWebSocket(rb.build(), new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                if (sockets.get(id) == webSocket) {
                    notifyListeners("chatSocketOpen", idOnly(id));
                }
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                if (sockets.get(id) != webSocket) return;
                JSObject data = idOnly(id);
                data.put("text", text);
                notifyListeners("chatSocketMessage", data);
            }

            @Override
            public void onClosing(WebSocket webSocket, int code, String reason) {
                webSocket.close(code, reason);
                finish(id, webSocket, code, reason);
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response r) {
                String msg = t.getMessage();
                finish(id, webSocket, 1006, msg == null ? "" : msg);
            }
        });
        sockets.put(id, ws);
        call.resolve();
    }

    /** Emits the close of a socket that is still registered, once. */
    private void finish(String id, WebSocket ws, int code, String reason) {
        if (!sockets.remove(id, ws)) return;
        JSObject data = idOnly(id);
        data.put("code", code);
        data.put("reason", reason);
        notifyListeners("chatSocketClose", data);
    }

    private static JSObject idOnly(String id) {
        JSObject data = new JSObject();
        data.put("id", id);
        return data;
    }

    @PluginMethod
    public void send(PluginCall call) {
        String id = call.getString("id");
        String text = call.getString("text", "");
        WebSocket ws = id == null ? null : sockets.get(id);
        if (ws == null) {
            call.reject("No open socket for this id");
            return;
        }
        if (!ws.send(text)) {
            call.reject("Socket is closing");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        String id = call.getString("id");
        WebSocket ws = id == null ? null : sockets.remove(id);
        if (ws != null) ws.close(1000, "");
        call.resolve();
    }
}
