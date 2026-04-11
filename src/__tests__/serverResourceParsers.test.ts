import { describe, it, expect } from "vitest";
import {
    fmtKb, fmtSpeed, fmtUptime,
    parseMem, parseCpu, parseLoad,
    parseCryptMounts, parseDisk,
    parseNet, parseUptime, parseUsers, parseSensors,
} from "../utils/serverResourceParsers";

// ── Formatting ────────────────────────────────────────────────────────────────

describe("fmtKb", () => {
    it("formats bytes (< 1 MB)", () => {
        expect(fmtKb(512)).toBe("512 KB");
        expect(fmtKb(1023)).toBe("1023 KB");
    });

    it("formats megabytes (1 MB – 1 GB)", () => {
        expect(fmtKb(1024)).toBe("1 MB");
        expect(fmtKb(2048)).toBe("2 MB");
        expect(fmtKb(512 * 1024)).toBe("512 MB");
    });

    it("formats gigabytes (≥ 1 GB)", () => {
        expect(fmtKb(1024 * 1024)).toBe("1.0 GB");
        expect(fmtKb(8 * 1024 * 1024)).toBe("8.0 GB");
        expect(fmtKb(1.5 * 1024 * 1024)).toBe("1.5 GB");
    });
});

describe("fmtSpeed", () => {
    it("formats bytes per second", () => {
        expect(fmtSpeed(500)).toBe("500 B/s");
    });

    it("formats kilobytes per second", () => {
        expect(fmtSpeed(1024)).toBe("1.0 KB/s");
        expect(fmtSpeed(512 * 1024)).toBe("512.0 KB/s");
    });

    it("formats megabytes per second", () => {
        expect(fmtSpeed(1024 * 1024)).toBe("1.00 MB/s");
        expect(fmtSpeed(10 * 1024 * 1024)).toBe("10.00 MB/s");
    });
});

describe("fmtUptime", () => {
    it("formats minutes-only uptime", () => {
        expect(fmtUptime(300)).toBe("5min");
    });

    it("formats hours + minutes", () => {
        expect(fmtUptime(3600 + 1800)).toBe("1h 30min");
    });

    it("formats days + hours + minutes", () => {
        expect(fmtUptime(2 * 86400 + 3 * 3600 + 15 * 60)).toBe("2j 3h 15min");
    });

    it("omits zero-valued components", () => {
        expect(fmtUptime(86400)).toBe("1j 0min");
        expect(fmtUptime(7200)).toBe("2h 0min");
    });
});

// ── parseMem ──────────────────────────────────────────────────────────────────

describe("parseMem", () => {
    const MEMINFO = [
        "MemTotal:       16384000 kB",
        "MemFree:         2048000 kB",
        "MemAvailable:    8192000 kB",
        "Buffers:          512000 kB",
        "Cached:          4096000 kB",
        "SReclaimable:     256000 kB",
        "SwapTotal:       8192000 kB",
        "SwapFree:        7168000 kB",
    ];

    it("computes totalKb correctly", () => {
        expect(parseMem(MEMINFO).totalKb).toBe(16384000);
    });

    it("computes cachedKb as Buffers + Cached + SReclaimable", () => {
        const { cachedKb } = parseMem(MEMINFO);
        expect(cachedKb).toBe(512000 + 4096000 + 256000); // 4864000
    });

    it("computes trulyUsedKb as total - free - cached", () => {
        const { trulyUsedKb } = parseMem(MEMINFO);
        expect(trulyUsedKb).toBe(16384000 - 2048000 - (512000 + 4096000 + 256000));
    });

    it("uses MemAvailable when present", () => {
        expect(parseMem(MEMINFO).availableKb).toBe(8192000);
    });

    it("falls back to MemFree for availableKb when MemAvailable absent", () => {
        const lines = MEMINFO.filter((l) => !l.startsWith("MemAvailable"));
        expect(parseMem(lines).availableKb).toBe(2048000);
    });

    it("returns zeros for missing fields", () => {
        const m = parseMem([]);
        expect(m.totalKb).toBe(0);
        expect(m.trulyUsedKb).toBe(0);
    });

    it("trulyUsedKb is never negative", () => {
        const lines = [
            "MemTotal:   1000 kB",
            "MemFree:    900 kB",
            "Cached:     200 kB",
        ];
        expect(parseMem(lines).trulyUsedKb).toBe(0);
    });
});

// ── parseCpu ──────────────────────────────────────────────────────────────────

describe("parseCpu", () => {
    it("returns null for empty string", () => {
        expect(parseCpu("")).toBeNull();
    });

    it("parses typical top output format", () => {
        const line = "%Cpu(s):  5.1 us,  2.3 sy,  0.0 ni, 91.2 id,  1.4 wa";
        const cpu = parseCpu(line);
        expect(cpu).not.toBeNull();
        expect(cpu!.userPct).toBe(5.1);
        expect(cpu!.sysPct).toBe(2.3);
        expect(cpu!.ioPct).toBe(1.4);
        expect(cpu!.idlePct).toBe(91.2);
    });

    it("returns 0 for missing fields", () => {
        const cpu = parseCpu("0.0 us 0.0 sy 0.0 wa 100.0 id");
        expect(cpu!.userPct).toBe(0);
    });
});

// ── parseLoad ─────────────────────────────────────────────────────────────────

describe("parseLoad", () => {
    it("returns null for empty string", () => {
        expect(parseLoad("")).toBeNull();
    });

    it("parses /proc/loadavg format", () => {
        const load = parseLoad("0.52 0.78 1.23 2/512 4096");
        expect(load).not.toBeNull();
        expect(load!.l1).toBe(0.52);
        expect(load!.l5).toBe(0.78);
        expect(load!.l15).toBe(1.23);
    });

    it("returns null if fewer than 3 fields", () => {
        expect(parseLoad("0.5 0.8")).toBeNull();
    });

    it("returns null if values are NaN", () => {
        expect(parseLoad("x y z")).toBeNull();
    });
});

// ── parseCryptMounts ──────────────────────────────────────────────────────────

describe("parseCryptMounts", () => {
    it("collects lines starting with /", () => {
        const s = parseCryptMounts(["/", "/home", "/boot"]);
        expect(s.has("/")).toBe(true);
        expect(s.has("/home")).toBe(true);
        expect(s.has("/boot")).toBe(true);
    });

    it("ignores lines not starting with /", () => {
        const s = parseCryptMounts(["crypt nvme0n1p3_crypt", "", "  "]);
        expect(s.size).toBe(0);
    });

    it("strips whitespace before checking prefix", () => {
        const s = parseCryptMounts(["  /data  "]);
        expect(s.has("/data")).toBe(true);
    });
});

// ── parseDisk ─────────────────────────────────────────────────────────────────

describe("parseDisk", () => {
    const DISK_LINES = [
        "/dev/sda1       50G  20G   28G  42% /",
        "/dev/sda2       20G   5G   14G  27% /home",
        "/dev/mapper/nvme0n1p3_crypt  200G  80G  108G  43% /data",
    ];

    it("parses basic df -hP output", () => {
        const disks = parseDisk(DISK_LINES, new Set());
        expect(disks).toHaveLength(3);
        expect(disks[0].mount).toBe("/");
        expect(disks[0].usePct).toBe(42);
        expect(disks[0].size).toBe("50G");
    });

    it("marks encrypted=true when mount is in cryptMounts set", () => {
        const mounts = new Set(["/data"]);
        const disks = parseDisk(DISK_LINES, mounts);
        const data = disks.find((d) => d.mount === "/data")!;
        expect(data.encrypted).toBe(true);
    });

    it("marks encrypted=true via filesystem name heuristic (_crypt suffix)", () => {
        const disks = parseDisk(DISK_LINES, new Set());
        const data = disks.find((d) => d.mount === "/data")!;
        expect(data.encrypted).toBe(true);
    });

    it("marks encrypted=false for plain partitions", () => {
        const disks = parseDisk(DISK_LINES, new Set());
        const root = disks.find((d) => d.mount === "/")!;
        expect(root.encrypted).toBe(false);
    });

    it("skips header line", () => {
        const lines = ["Filesystem Size Used Avail Use% Mounted on", ...DISK_LINES];
        expect(parseDisk(lines, new Set())).toHaveLength(3);
    });

    it("handles mount points with spaces", () => {
        const line = "/dev/sda3  10G  2G  7G  22% /mnt/my drive";
        const disks = parseDisk([line], new Set());
        expect(disks[0].mount).toBe("/mnt/my drive");
    });
});

// ── parseNet ──────────────────────────────────────────────────────────────────

describe("parseNet", () => {
    // Minimal /proc/net/dev lines (header + lo + eth0)
    const makeNetDev = (rxBytes: number, txBytes: number) => [
        "Inter-|   Receive                                                |  Transmit",
        " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
        `    lo:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0`,
        `  eth0: ${rxBytes}    1234    0    0    0     0          0         0 ${txBytes}    5678    0    0    0     0       0          0`,
    ];

    it("returns null for empty input", () => {
        expect(parseNet([], [])).toBeNull();
    });

    it("computes bytes-per-second from two readings 1s apart", () => {
        const snap1 = makeNetDev(1_000_000, 500_000);
        const snap2 = makeNetDev(1_002_048, 500_512);
        const net = parseNet(snap1, snap2)!;
        expect(net.rxBytesPerSec).toBe(2048);
        expect(net.txBytesPerSec).toBe(512);
    });

    it("treats counter wrap (negative delta) as 0", () => {
        const snap1 = makeNetDev(2_000_000, 0);
        const snap2 = makeNetDev(1_000_000, 0); // counter went backward
        const net = parseNet(snap1, snap2)!;
        expect(net.rxBytesPerSec).toBe(0);
    });

    it("ignores loopback interface", () => {
        const loLines = [
            "    lo: 999999  1  0  0  0  0  0  0  888888  2  0  0  0  0  0  0",
        ];
        // lo is excluded from accounting; result is 0/0, not null
        const net = parseNet(loLines, loLines)!;
        expect(net.rxBytesPerSec).toBe(0);
        expect(net.txBytesPerSec).toBe(0);
    });
});

// ── parseUptime ───────────────────────────────────────────────────────────────

describe("parseUptime", () => {
    it("parses the first field of /proc/uptime", () => {
        expect(parseUptime("3600.12 1800.00")).toBe(3600.12);
    });

    it("returns null for empty string", () => {
        expect(parseUptime("")).toBeNull();
    });

    it("returns null for non-numeric content", () => {
        expect(parseUptime("not a number")).toBeNull();
    });
});

// ── parseUsers ────────────────────────────────────────────────────────────────

describe("parseUsers", () => {
    it("returns empty array for empty input", () => {
        expect(parseUsers("")).toEqual([]);
    });

    it("counts occurrences of each username", () => {
        const result = parseUsers("alice bob alice charlie alice");
        const alice = result.find((u) => u.username === "alice")!;
        const bob = result.find((u) => u.username === "bob")!;
        expect(alice.count).toBe(3);
        expect(bob.count).toBe(1);
    });

    it("sorts usernames alphabetically", () => {
        const result = parseUsers("zara alice bob");
        expect(result.map((u) => u.username)).toEqual(["alice", "bob", "zara"]);
    });

    it("handles single user", () => {
        const result = parseUsers("root");
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({ username: "root", count: 1 });
    });
});

// ── parseSensors ──────────────────────────────────────────────────────────────

describe("parseSensors", () => {
    const SENSORS_OUTPUT = [
        "coretemp-isa-0000",
        "Adapter: ISA adapter",
        "Package id 0:  +52.0°C  (high = +80.0°C, crit = +100.0°C)",
        "Core 0:        +48.0°C  (high = +80.0°C, crit = +100.0°C)",
        "Core 1:        +50.0°C  (high = +80.0°C, crit = +100.0°C)",
        "",
        "acpitz-acpi-0",
        "Adapter: ACPI interface",
        "temp1:         +27.8°C  (crit = +119.0°C)",
    ];

    it("parses chip name and temperature values", () => {
        const sensors = parseSensors(SENSORS_OUTPUT);
        const coreSensors = sensors.filter((s) => s.chip === "coretemp-isa-0000");
        expect(coreSensors.length).toBeGreaterThan(0);
        expect(coreSensors[0].tempC).toBe(52.0);
    });

    it("extracts high and crit thresholds", () => {
        const sensors = parseSensors(SENSORS_OUTPUT);
        const pkg = sensors.find((s) => s.label.includes("Package"))!;
        expect(pkg.highC).toBe(80.0);
        expect(pkg.critC).toBe(100.0);
    });

    it("handles missing high threshold (null)", () => {
        const sensors = parseSensors(SENSORS_OUTPUT);
        const acpi = sensors.find((s) => s.chip === "acpitz-acpi-0")!;
        expect(acpi.highC).toBeNull();
        expect(acpi.critC).toBe(119.0);
    });

    it("groups sensors by chip", () => {
        const sensors = parseSensors(SENSORS_OUTPUT);
        const chips = [...new Set(sensors.map((s) => s.chip))];
        expect(chips).toContain("coretemp-isa-0000");
        expect(chips).toContain("acpitz-acpi-0");
    });

    it("returns empty array for empty input", () => {
        expect(parseSensors([])).toEqual([]);
    });

    it("ignores lines without temperature units", () => {
        const lines = ["some-chip", "Adapter: ISA adapter", "fan1:  1200 RPM"];
        expect(parseSensors(lines)).toHaveLength(0);
    });
});
