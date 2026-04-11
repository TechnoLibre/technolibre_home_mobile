// ── Data types ────────────────────────────────────────────────────────────────

export interface MemInfo {
    totalKb: number;
    trulyUsedKb: number;
    cachedKb: number;
    availableKb: number;
    swapTotalKb: number;
    swapFreeKb: number;
}

export interface CpuInfo {
    userPct: number;
    sysPct: number;
    ioPct: number;
    idlePct: number;
}

export interface DiskPartition {
    filesystem: string;
    size: string;
    used: string;
    avail: string;
    usePct: number;
    mount: string;
    encrypted: boolean;
}

export interface NetInfo {
    rxBytesPerSec: number;
    txBytesPerSec: number;
}

export interface UserCount {
    username: string;
    count: number;
}

export interface TempSensor {
    chip: string;
    label: string;
    tempC: number;
    highC: number | null;
    critC: number | null;
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function fmtKb(kb: number): string {
    if (kb >= 1024 * 1024) return (kb / 1024 / 1024).toFixed(1) + " GB";
    if (kb >= 1024) return Math.round(kb / 1024) + " MB";
    return kb + " KB";
}

export function fmtSpeed(bps: number): string {
    if (bps >= 1024 * 1024) return (bps / 1024 / 1024).toFixed(2) + " MB/s";
    if (bps >= 1024) return (bps / 1024).toFixed(1) + " KB/s";
    return bps + " B/s";
}

export function fmtUptime(secs: number): string {
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const parts: string[] = [];
    if (d > 0) parts.push(`${d}j`);
    if (h > 0) parts.push(`${h}h`);
    parts.push(`${m}min`);
    return parts.join(" ");
}

// ── Parsing ───────────────────────────────────────────────────────────────────

export function parseMem(lines: string[]): MemInfo {
    const map: Record<string, number> = {};
    for (const line of lines) {
        const m = line.match(/^(\w+):\s+(\d+)/);
        if (m) map[m[1]] = parseInt(m[2], 10);
    }
    const total    = map["MemTotal"]     || 0;
    const free     = map["MemFree"]      || 0;
    const avail    = map["MemAvailable"] || free;
    const buffers  = map["Buffers"]      || 0;
    const cached   = map["Cached"]       || 0;
    const sreclaim = map["SReclaimable"] || 0;
    const cachedKb = buffers + cached + sreclaim;
    return {
        totalKb:     total,
        trulyUsedKb: Math.max(0, total - free - cachedKb),
        cachedKb,
        availableKb: avail,
        swapTotalKb: map["SwapTotal"] || 0,
        swapFreeKb:  map["SwapFree"]  || 0,
    };
}

export function parseCpu(line: string): CpuInfo | null {
    if (!line) return null;
    const get = (key: string): number => {
        const m = line.match(new RegExp("([\\d.]+)[%\\s]+" + key));
        return m ? parseFloat(m[1]) : 0;
    };
    return { userPct: get("us"), sysPct: get("sy"), ioPct: get("wa"), idlePct: get("id") };
}

export function parseLoad(line: string): { l1: number; l5: number; l15: number } | null {
    if (!line) return null;
    const p = line.trim().split(/\s+/);
    if (p.length < 3) return null;
    const l1 = parseFloat(p[0]), l5 = parseFloat(p[1]), l15 = parseFloat(p[2]);
    if (isNaN(l1) || isNaN(l5) || isNaN(l15)) return null;
    return { l1, l5, l15 };
}

export function parseCryptMounts(lines: string[]): Set<string> {
    const s = new Set<string>();
    for (const line of lines) {
        const m = line.trim();
        // Each output line is a bare mount path produced by the lsblk loop
        if (m.startsWith("/")) s.add(m);
    }
    return s;
}

export function parseDisk(lines: string[], cryptMounts: Set<string>): DiskPartition[] {
    const result: DiskPartition[] = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 6 || parts[0] === "Filesystem") continue;
        const pct = parseInt(parts[4].replace("%", ""), 10) || 0;
        const mount = parts.slice(5).join(" ");
        const fs = parts[0];
        const encrypted = cryptMounts.has(mount) || /_crypt$|[-_]crypt\d*$|\/luks-[0-9a-f]/.test(fs);
        result.push({ filesystem: fs, size: parts[1], used: parts[2], avail: parts[3], usePct: pct, mount, encrypted });
    }
    return result;
}

export function parseNetDev(lines: string[]): Record<string, [number, number]> {
    const r: Record<string, [number, number]> = {};
    for (const line of lines) {
        const m = line.match(/^\s*([^\s:]+):\s+(\d+)(?:\s+\d+){7}\s+(\d+)/);
        if (m && m[1] !== "lo") r[m[1]] = [parseInt(m[2], 10), parseInt(m[3], 10)];
    }
    return r;
}

export function parseNet(lines1: string[], lines2: string[]): NetInfo | null {
    if (!lines1.length || !lines2.length) return null;
    const a = parseNetDev(lines1), b = parseNetDev(lines2);
    let rx = 0, tx = 0;
    for (const iface in a) {
        if (b[iface]) {
            rx += Math.max(0, b[iface][0] - a[iface][0]);
            tx += Math.max(0, b[iface][1] - a[iface][1]);
        }
    }
    return { rxBytesPerSec: rx, txBytesPerSec: tx };
}

export function parseUptime(line: string): number | null {
    if (!line) return null;
    const val = parseFloat(line.trim().split(/\s+/)[0]);
    return isNaN(val) ? null : val;
}

export function parseUsers(line: string): UserCount[] {
    const names = (line || "").trim().split(/\s+/).filter(Boolean);
    const counts: Record<string, number> = {};
    for (const name of names) counts[name] = (counts[name] || 0) + 1;
    return Object.entries(counts)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([username, count]) => ({ username, count }));
}

export function parseSensors(lines: string[]): TempSensor[] {
    const result: TempSensor[] = [];
    let chip = "";
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) { chip = ""; continue; }
        // Chip name: non-empty, no colon (all value lines have "label: value")
        if (!trimmed.includes(":")) { chip = trimmed; continue; }
        if (!chip) continue;
        // Temperature line: label: +XX.X°C (optional high/crit)
        const m = trimmed.match(/^(.+?):\s+[+-]?(\d+\.?\d*)°C/);
        if (!m) continue;
        const highM = trimmed.match(/high\s*=\s*[+-]?(\d+\.?\d*)°C/);
        const critM = trimmed.match(/crit\s*=\s*[+-]?(\d+\.?\d*)°C/);
        result.push({
            chip,
            label: m[1],
            tempC: parseFloat(m[2]),
            highC: highM ? parseFloat(highM[1]) : null,
            critC: critM ? parseFloat(critM[1]) : null,
        });
    }
    return result;
}
