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

    private long lastCpuTotal = 0;
    private long lastCpuIdle  = 0;

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
     * Falls back to /proc/loadavg if /proc/stat is not readable (API >= 26 restriction).
     */
    private double readCpuPercent() {
        try (BufferedReader br = new BufferedReader(new FileReader("/proc/stat"))) {
            String line = br.readLine();
            if (line == null || !line.startsWith("cpu ")) return readLoadAvgAsPercent();

            // "cpu  user nice system idle iowait irq softirq steal guest guest_nice"
            String[] p = line.trim().split("\\s+");
            long user   = Long.parseLong(p[1]);
            long nice   = Long.parseLong(p[2]);
            long system = Long.parseLong(p[3]);
            long idle   = Long.parseLong(p[4]);
            long iowait = p.length > 5 ? Long.parseLong(p[5]) : 0;
            long irq    = p.length > 6 ? Long.parseLong(p[6]) : 0;
            long sirq   = p.length > 7 ? Long.parseLong(p[7]) : 0;

            long total  = user + nice + system + idle + iowait + irq + sirq;
            long idleT  = idle + iowait;

            if (lastCpuTotal == 0) {
                // First call — store baseline, return 0
                lastCpuTotal = total;
                lastCpuIdle  = idleT;
                return 0;
            }

            long dTotal = total - lastCpuTotal;
            long dIdle  = idleT  - lastCpuIdle;
            lastCpuTotal = total;
            lastCpuIdle  = idleT;
            if (dTotal <= 0) return 0;
            return (double)(dTotal - dIdle) / dTotal * 100.0;

        } catch (Exception e) {
            return readLoadAvgAsPercent();
        }
    }

    /** Estimate CPU usage from /proc/loadavg ÷ cpu-count (always readable). */
    private double readLoadAvgAsPercent() {
        try (BufferedReader br = new BufferedReader(new FileReader("/proc/loadavg"))) {
            String line = br.readLine();
            if (line == null) return 0;
            double load1 = Double.parseDouble(line.split("\\s+")[0]);
            int cpus = Runtime.getRuntime().availableProcessors();
            return Math.min(load1 / cpus * 100.0, 100.0);
        } catch (Exception ignored) {
            return 0;
        }
    }
}
