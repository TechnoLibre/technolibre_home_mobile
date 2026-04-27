package ca.erplibre.home;

import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Capacitor plugin that scans the local /24 subnet for open SSH (port 22)
 * services and reports each discovered host in real time.
 *
 * JavaScript surface:
 *   scan({ timeoutMs? })  → { hosts: [{ host, port, banner }] }
 *   cancelScan()          → void
 *
 * Events:
 *   "hostFound" → { host, port, banner }
 */
@CapacitorPlugin(name = "NetworkScanPlugin")
public class NetworkScanPlugin extends Plugin {

    private static final String TAG        = "NetworkScanPlugin";
    private static final int    SSH_PORT   = 22;
    private static final int    THREADS    = 50;

    private final AtomicBoolean isScanning = new AtomicBoolean(false);
    private volatile ExecutorService executor;

    // ─────────────────────────────────────────────────────────────────────────

    @PluginMethod
    public void scan(PluginCall call) {
        if (isScanning.getAndSet(true)) {
            call.reject("Scan already in progress");
            return;
        }

        final int timeoutMs = call.getInt("timeoutMs", 500);

        // Determine the local IPv4 address and derive the /24 base (e.g. "192.168.1")
        final String localIp = getLocalIpv4();
        if (localIp == null) {
            isScanning.set(false);
            call.reject("No active WiFi/LAN connection found. Connect to a network and retry.");
            return;
        }

        final int lastDot = localIp.lastIndexOf('.');
        if (lastDot < 0) {
            isScanning.set(false);
            call.reject("Invalid IP: " + localIp);
            return;
        }
        final String base = localIp.substring(0, lastDot);
        Log.i(TAG, "Scanning " + base + ".1–254 on port " + SSH_PORT + " (timeout=" + timeoutMs + " ms)");

        executor = Executors.newFixedThreadPool(THREADS);
        final List<JSObject> results = Collections.synchronizedList(new ArrayList<>());
        final CountDownLatch latch   = new CountDownLatch(254);

        for (int i = 1; i <= 254; i++) {
            final String host = base + "." + i;
            executor.submit(() -> {
                try {
                    if (!isScanning.get()) return;
                    final String banner = probeSsh(host, SSH_PORT, timeoutMs);
                    if (banner != null && isScanning.get()) {
                        // Reverse DNS — only for confirmed SSH hosts, so overhead is minimal.
                        String hostname = null;
                        try {
                            String canonical = InetAddress.getByName(host).getCanonicalHostName();
                            if (canonical != null && !canonical.equals(host)) {
                                hostname = canonical;
                            }
                        } catch (Exception ignored) {}

                        JSObject found = new JSObject();
                        found.put("host",   host);
                        found.put("port",   SSH_PORT);
                        found.put("banner", banner);
                        if (hostname != null) found.put("hostname", hostname);
                        results.add(found);
                        notifyListeners("hostFound", found);
                        Log.i(TAG, "SSH found: " + host
                                + (hostname != null ? " (" + hostname + ")" : "")
                                + "  [" + banner + "]");
                    }
                } catch (Exception ignored) {
                    // unreachable host — expected
                } finally {
                    latch.countDown();
                }
            });
        }

        // Wait for all probes, then resolve
        new Thread(() -> {
            try {
                latch.await(30, TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {}

            executor.shutdownNow();
            isScanning.set(false);

            JSArray arr = new JSArray();
            for (JSObject o : results) arr.put(o);

            JSObject result = new JSObject();
            result.put("hosts", arr);
            call.resolve(result);

            Log.i(TAG, "Scan complete — " + results.size() + " SSH host(s) found");
        }).start();
    }

    @PluginMethod
    public void cancelScan(PluginCall call) {
        isScanning.set(false);
        final ExecutorService ex = executor;
        if (ex != null) ex.shutdownNow();
        call.resolve();
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * Try to connect to host:port and read the SSH banner.
     * Returns the banner string if the service responds with "SSH-...", null otherwise.
     */
    private String probeSsh(String host, int port, int timeoutMs) {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(host, port), timeoutMs);
            socket.setSoTimeout(timeoutMs);
            try (InputStream in = socket.getInputStream()) {
                byte[] buf = new byte[256];
                int n = in.read(buf);
                if (n > 0) {
                    String banner = new String(buf, 0, n, StandardCharsets.UTF_8).trim();
                    if (banner.startsWith("SSH-")) {
                        // Truncate long banners
                        return banner.length() > 64 ? banner.substring(0, 64) : banner;
                    }
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    /**
     * Enumerates every active network interface on the device and the
     * IPv4 / IPv6 addresses bound to it. No permission required —
     * NetworkInterface enumeration goes through the Java NIO stack.
     *
     * Each entry: { name, displayName, up, loopback, mac (or ""),
     * addresses: [{ ip, family ("ipv4"|"ipv6"), prefixLength }] }
     */
    @PluginMethod
    public void listInterfaces(PluginCall call) {
        JSArray out = new JSArray();
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            if (ifaces != null) {
                while (ifaces.hasMoreElements()) {
                    NetworkInterface iface = ifaces.nextElement();
                    JSObject row = new JSObject();
                    row.put("name", iface.getName());
                    row.put("displayName", iface.getDisplayName() != null ? iface.getDisplayName() : "");
                    boolean up = false;
                    try { up = iface.isUp(); } catch (Throwable ignored) { /* permission edge case */ }
                    row.put("up", up);
                    boolean loopback = false;
                    try { loopback = iface.isLoopback(); } catch (Throwable ignored) {}
                    row.put("loopback", loopback);
                    String mac = "";
                    try {
                        byte[] hw = iface.getHardwareAddress();
                        if (hw != null) {
                            StringBuilder sb = new StringBuilder();
                            for (int i = 0; i < hw.length; i++) {
                                if (i > 0) sb.append(":");
                                sb.append(String.format("%02x", hw[i] & 0xFF));
                            }
                            mac = sb.toString();
                        }
                    } catch (Throwable ignored) {}
                    row.put("mac", mac);
                    JSArray addrs = new JSArray();
                    try {
                        for (java.net.InterfaceAddress ia : iface.getInterfaceAddresses()) {
                            InetAddress a = ia.getAddress();
                            if (a == null) continue;
                            JSObject ao = new JSObject();
                            String host = a.getHostAddress();
                            if (host == null) continue;
                            // Strip the IPv6 zone id ("fe80::1%wlan0" → "fe80::1").
                            int pct = host.indexOf('%');
                            if (pct >= 0) host = host.substring(0, pct);
                            ao.put("ip", host);
                            ao.put("family", (a instanceof Inet4Address) ? "ipv4" : "ipv6");
                            ao.put("prefixLength", ia.getNetworkPrefixLength());
                            addrs.put(ao);
                        }
                    } catch (Throwable ignored) {}
                    row.put("addresses", addrs);
                    out.put(row);
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "listInterfaces failed", e);
            call.reject("listInterfaces:" + e.getMessage());
            return;
        }
        JSObject r = new JSObject();
        r.put("interfaces", out);
        call.resolve(r);
    }

    /**
     * Returns the first non-loopback IPv4 address of an active network interface
     * (works for WiFi, Ethernet, USB-tethering — no special permission required).
     */
    private String getLocalIpv4() {
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            if (ifaces == null) return null;
            while (ifaces.hasMoreElements()) {
                NetworkInterface iface = ifaces.nextElement();
                if (!iface.isUp() || iface.isLoopback() || iface.isVirtual()) continue;
                Enumeration<InetAddress> addrs = iface.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress addr = addrs.nextElement();
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "getLocalIpv4 failed", e);
        }
        return null;
    }
}
