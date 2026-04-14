package ca.erplibre.home;

import android.app.ActivityManager;
import android.content.Context;
import android.net.TrafficStats;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.FileReader;

/**
 * Reads live device resource statistics:
 *   - RAM  : total / used / available (bytes)  via ActivityManager.MemoryInfo
 *   - CPU  : usage percentage via /proc/stat delta (fallback: /proc/loadavg)
 *   - Net  : download / upload speed (bytes/sec) via TrafficStats delta
 *
 * Call getStats() repeatedly; the first CPU call returns 0% (no prior snapshot).
 */
@CapacitorPlugin(name = "DeviceStatsPlugin")
public class DeviceStatsPlugin extends Plugin {

    // ── CPU delta state ───────────────────────────────────────────────────────
    // static: survives plugin re-instantiation across component lifecycle

    private static long lastCpuTotal = 0;
    private static long lastCpuIdle  = 0;

    // ── Network delta state ───────────────────────────────────────────────────

    private long lastRxBytes = -1;
    private long lastTxBytes = -1;
    private long lastNetTs   = 0;

    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Returns a snapshot of device resource usage.
     *
     * Resolved object shape:
     *   ramTotal         long    — total physical RAM in bytes
     *   ramUsed          long    — used RAM in bytes
     *   ramAvail         long    — available RAM in bytes
     *   ramPct           double  — used% (0-100)
     *   cpuPct           double  — CPU busy% (0-100), 0 on first call
     *   netRxBytesPerSec long    — download speed bytes/sec
     *   netTxBytesPerSec long    — upload speed bytes/sec
     */
    @PluginMethod
    public void getStats(PluginCall call) {

        // ── RAM ───────────────────────────────────────────────────────────────
        ActivityManager am = (ActivityManager)
            getContext().getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo mem = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mem);

        long ramTotal = mem.totalMem;
        long ramAvail = mem.availMem;
        long ramUsed  = ramTotal - ramAvail;
        double ramPct = ramTotal > 0 ? (double) ramUsed / ramTotal * 100.0 : 0;

        // ── CPU ───────────────────────────────────────────────────────────────
        double cpuPct = readCpuPercent();

        // ── Network ───────────────────────────────────────────────────────────
        long rxBytes = TrafficStats.getTotalRxBytes();
        long txBytes = TrafficStats.getTotalTxBytes();
        long now     = System.currentTimeMillis();
        long rxPerSec = 0;
        long txPerSec = 0;

        if (lastRxBytes >= 0 && rxBytes >= 0 && txBytes >= 0) {
            long elapsed = now - lastNetTs;
            if (elapsed > 0) {
                rxPerSec = (rxBytes - lastRxBytes) * 1000L / elapsed;
                txPerSec = (txBytes - lastTxBytes) * 1000L / elapsed;
                if (rxPerSec < 0) rxPerSec = 0;
                if (txPerSec < 0) txPerSec = 0;
            }
        }
        lastRxBytes = rxBytes;
        lastTxBytes = txBytes;
        lastNetTs   = now;

        // ── Result ────────────────────────────────────────────────────────────
        JSObject result = new JSObject();
        result.put("ramTotal",           ramTotal);
        result.put("ramUsed",            ramUsed);
        result.put("ramAvail",           ramAvail);
        result.put("ramPct",             Math.round(ramPct  * 10.0) / 10.0);
        result.put("cpuPct",             Math.round(cpuPct  * 10.0) / 10.0);
        result.put("netRxBytesPerSec",   rxPerSec);
        result.put("netTxBytesPerSec",   txPerSec);
        call.resolve(result);
    }

    // ── CPU helpers ───────────────────────────────────────────────────────────

    /**
     * Read /proc/stat and compute CPU% as the delta between two successive calls.
     *
     * On Android 12+ /proc/stat may be SELinux-restricted; falls back to
     * readCpuFallback() which tries CPU-frequency scaling first, then
     * /proc/loadavg.
     *
     * The first call always uses the fallback so that the UI shows a
     * meaningful value immediately instead of the usual 0 % baseline.
     */
    private double readCpuPercent() {
        try (BufferedReader br = new BufferedReader(new FileReader("/proc/stat"))) {
            String line = br.readLine();
            if (line == null || !line.startsWith("cpu ")) return readCpuFallback();

            // "cpu  user nice system idle iowait irq softirq steal guest guest_nice"
            String[] p = line.trim().split("\\s+");
            long user   = Long.parseLong(p[1]);
            long nice   = Long.parseLong(p[2]);
            long system = Long.parseLong(p[3]);
            long idle   = Long.parseLong(p[4]);
            long iowait = p.length > 5 ? Long.parseLong(p[5]) : 0;
            long irq    = p.length > 6 ? Long.parseLong(p[6]) : 0;
            long sirq   = p.length > 7 ? Long.parseLong(p[7]) : 0;
            long steal  = p.length > 8 ? Long.parseLong(p[8]) : 0;

            long total  = user + nice + system + idle + iowait + irq + sirq + steal;
            long idleT  = idle + iowait;

            if (lastCpuTotal == 0) {
                // First call — store baseline, use fallback for immediate display
                lastCpuTotal = total;
                lastCpuIdle  = idleT;
                return readCpuFallback();
            }

            long dTotal = total - lastCpuTotal;
            long dIdle  = idleT  - lastCpuIdle;
            lastCpuTotal = total;
            lastCpuIdle  = idleT;
            if (dTotal <= 0) return readCpuFallback();
            return (double)(dTotal - dIdle) / dTotal * 100.0;

        } catch (Exception e) {
            return readCpuFallback();
        }
    }

    /**
     * Fallback CPU estimate for Android 12+ where /proc/stat is restricted.
     *
     * Strategy:
     *  1. Average CPU-frequency ratio across all cores from sysfs — responsive
     *     to load because governors (schedutil, interactive) scale frequency
     *     proportionally to CPU demand.
     *  2. /proc/loadavg ÷ cpu-count — always readable, 1-min EMA approximation.
     *  3. 0 if both sources are unavailable.
     */
    private double readCpuFallback() {
        // ── 1. CPU frequency scaling ─────────────────────────────────────────
        int cores = Runtime.getRuntime().availableProcessors();
        double freqRatioSum = 0;
        int freqCount = 0;
        for (int i = 0; i < cores; i++) {
            try {
                String base = "/sys/devices/system/cpu/cpu" + i + "/cpufreq/";
                long cur = readLongFromFile(base + "scaling_cur_freq");
                long max = readLongFromFile(base + "cpuinfo_max_freq");
                if (max > 0 && cur >= 0) {
                    freqRatioSum += (double) cur / max;
                    freqCount++;
                }
            } catch (Exception ignored) { }
        }
        if (freqCount > 0) {
            return freqRatioSum / freqCount * 100.0;
        }

        // ── 2. /proc/loadavg ─────────────────────────────────────────────────
        try (BufferedReader br = new BufferedReader(new FileReader("/proc/loadavg"))) {
            String line = br.readLine();
            if (line != null) {
                double load1 = Double.parseDouble(line.split("\\s+")[0]);
                return Math.min(load1 / cores * 100.0, 100.0);
            }
        } catch (Exception ignored) { }

        return 0;
    }

    private long readLongFromFile(String path) throws Exception {
        try (BufferedReader br = new BufferedReader(new FileReader(path))) {
            return Long.parseLong(br.readLine().trim());
        }
    }
}
