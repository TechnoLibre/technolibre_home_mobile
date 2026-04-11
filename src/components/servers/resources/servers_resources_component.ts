import { useState, xml } from "@odoo/owl";
import type { PluginListenerHandle } from "@capacitor/core";

import { Server } from "../../../models/server";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { HeadingComponent } from "../../heading/heading_component";
import { SshPlugin } from "../../../plugins/sshPlugin";

// ── Data types ────────────────────────────────────────────────────────────────

interface MemInfo {
    totalKb: number;
    trulyUsedKb: number;
    cachedKb: number;
    availableKb: number;
    swapTotalKb: number;
    swapFreeKb: number;
}

interface CpuInfo {
    userPct: number;
    sysPct: number;
    ioPct: number;
    idlePct: number;
}

interface DiskPartition {
    filesystem: string;
    size: string;
    used: string;
    avail: string;
    usePct: number;
    mount: string;
    encrypted: boolean;
}

interface NetInfo {
    rxBytesPerSec: number;
    txBytesPerSec: number;
}

interface UserCount {
    username: string;
    count: number;
}

interface TempSensor {
    chip: string;
    label: string;
    tempC: number;
    highC: number | null;
    critC: number | null;
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtKb(kb: number): string {
    if (kb >= 1024 * 1024) return (kb / 1024 / 1024).toFixed(1) + " GB";
    if (kb >= 1024) return Math.round(kb / 1024) + " MB";
    return kb + " KB";
}

function fmtSpeed(bps: number): string {
    if (bps >= 1024 * 1024) return (bps / 1024 / 1024).toFixed(2) + " MB/s";
    if (bps >= 1024) return (bps / 1024).toFixed(1) + " KB/s";
    return bps + " B/s";
}

function fmtUptime(secs: number): string {
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

function parseMem(lines: string[]): MemInfo {
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

function parseCpu(line: string): CpuInfo | null {
    if (!line) return null;
    const get = (key: string): number => {
        const m = line.match(new RegExp("([\\d.]+)[%\\s]+" + key));
        return m ? parseFloat(m[1]) : 0;
    };
    return { userPct: get("us"), sysPct: get("sy"), ioPct: get("wa"), idlePct: get("id") };
}

function parseLoad(line: string): { l1: number; l5: number; l15: number } | null {
    if (!line) return null;
    const p = line.trim().split(/\s+/);
    if (p.length < 3) return null;
    const l1 = parseFloat(p[0]), l5 = parseFloat(p[1]), l15 = parseFloat(p[2]);
    if (isNaN(l1) || isNaN(l5) || isNaN(l15)) return null;
    return { l1, l5, l15 };
}

function parseCryptMounts(lines: string[]): Set<string> {
    const s = new Set<string>();
    for (const line of lines) {
        const m = line.trim();
        // Each output line is a bare mount path produced by the lsblk loop
        if (m.startsWith("/")) s.add(m);
    }
    return s;
}

function parseDisk(lines: string[], cryptMounts: Set<string>): DiskPartition[] {
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

function parseNetDev(lines: string[]): Record<string, [number, number]> {
    const r: Record<string, [number, number]> = {};
    for (const line of lines) {
        const m = line.match(/^\s*([^\s:]+):\s+(\d+)(?:\s+\d+){7}\s+(\d+)/);
        if (m && m[1] !== "lo") r[m[1]] = [parseInt(m[2], 10), parseInt(m[3], 10)];
    }
    return r;
}

function parseNet(lines1: string[], lines2: string[]): NetInfo | null {
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

function parseUptime(line: string): number | null {
    if (!line) return null;
    const val = parseFloat(line.trim().split(/\s+/)[0]);
    return isNaN(val) ? null : val;
}

function parseUsers(line: string): UserCount[] {
    const names = (line || "").trim().split(/\s+/).filter(Boolean);
    const counts: Record<string, number> = {};
    for (const name of names) counts[name] = (counts[name] || 0) + 1;
    return Object.entries(counts)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([username, count]) => ({ username, count }));
}

function parseSensors(lines: string[]): TempSensor[] {
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
            label: m[1].trim(),
            tempC: parseFloat(m[2]),
            highC: highM ? parseFloat(highM[1]) : null,
            critC: critM ? parseFloat(critM[1]) : null,
        });
    }
    return result;
}

// ── Component ─────────────────────────────────────────────────────────────────

export class ServersResourcesComponent extends EnhancedComponent {
    static template = xml`
      <div id="servers-resources-component">
        <HeadingComponent title="'Ressources'" breadcrumbs="breadcrumbs" />

        <!-- ── Toolbar ─────────────────────────────────────────── -->
        <div class="res__toolbar">
          <button class="res__btn-refresh"
                  t-att-disabled="state.status === 'loading'"
                  t-on-click="() => this.refresh()">
            <t t-if="state.status === 'loading'">
              <span class="res__spinner">◌</span> Chargement…
            </t>
            <t t-else="">↻ Actualiser</t>
          </button>
          <span class="res__updated" t-if="state.updatedAt">
            <t t-esc="state.updatedAt" />
          </span>
        </div>

        <!-- ── Error ───────────────────────────────────────────── -->
        <t t-if="state.status === 'error'">
          <div class="res__error" t-esc="state.errorMessage" />
        </t>

        <!-- ── Data ────────────────────────────────────────────── -->
        <t t-if="state.status === 'done'">
          <div class="res__sections">

            <!-- RAM -->
            <t t-if="state.mem">
              <div class="res__section">
                <div class="res__section-title">Mémoire RAM</div>
                <div class="res__bar-row">
                  <div class="res__bar">
                    <div class="res__bar-fill res__bar-fill--used"
                         t-att-style="'width:' + memTrulyUsedPct + '%'" />
                    <div class="res__bar-fill res__bar-fill--cache"
                         t-att-style="'width:' + memCachePct + '%'" />
                  </div>
                  <span class="res__bar-pct" t-esc="memTrulyUsedPct + '%'" />
                </div>
                <div class="res__metrics">
                  <span class="res__metric">Total <span class="res__val" t-esc="fmtKb(state.mem.totalKb)" /></span>
                  <span class="res__metric"><span class="res__legend res__legend--used"></span>Utilisée <span class="res__val" t-esc="fmtKb(state.mem.trulyUsedKb)" /></span>
                  <span class="res__metric"><span class="res__legend res__legend--cache"></span>Cache <span class="res__val res__val--cache" t-esc="fmtKb(state.mem.cachedKb)" /></span>
                  <span class="res__metric">Disponible <span class="res__val res__val--ok" t-esc="fmtKb(state.mem.availableKb)" /></span>
                </div>
              </div>
            </t>

            <!-- Swap -->
            <t t-if="state.mem">
              <div class="res__section">
                <div class="res__section-title">Swap</div>
                <t t-if="state.mem.swapTotalKb === 0">
                  <div class="res__empty">Aucun swap configuré.</div>
                </t>
                <t t-else="">
                  <div class="res__bar-row">
                    <div class="res__bar">
                      <div class="res__bar-fill"
                           t-att-style="'width:' + swapUsedPct + '%;background-color:' + barColor(swapUsedPct)" />
                    </div>
                    <span class="res__bar-pct" t-esc="swapUsedPct + '%'" />
                  </div>
                  <div class="res__metrics">
                    <span class="res__metric">Total <span class="res__val" t-esc="fmtKb(state.mem.swapTotalKb)" /></span>
                    <span class="res__metric">Utilisé <span class="res__val" t-esc="fmtKb(state.mem.swapTotalKb - state.mem.swapFreeKb)" /></span>
                    <span class="res__metric">Libre <span class="res__val res__val--ok" t-esc="fmtKb(state.mem.swapFreeKb)" /></span>
                  </div>
                </t>
              </div>
            </t>

            <!-- CPU -->
            <t t-if="state.cpu">
              <div class="res__section">
                <div class="res__section-title">CPU</div>
                <div class="res__bar-row">
                  <div class="res__bar">
                    <div class="res__bar-fill"
                         t-att-style="'width:' + cpuUsedPct + '%;background-color:' + barColor(cpuUsedPct)" />
                  </div>
                  <span class="res__bar-pct" t-esc="cpuUsedPct + '%'" />
                </div>
                <div class="res__metrics">
                  <span class="res__metric">Utilisateur <span class="res__val" t-esc="state.cpu.userPct.toFixed(1) + '%'" /></span>
                  <span class="res__metric">Système <span class="res__val" t-esc="state.cpu.sysPct.toFixed(1) + '%'" /></span>
                  <span class="res__metric">I/O wait <span class="res__val" t-esc="state.cpu.ioPct.toFixed(1) + '%'" /></span>
                  <span class="res__metric">Inactif <span class="res__val res__val--ok" t-esc="state.cpu.idlePct.toFixed(1) + '%'" /></span>
                </div>
                <t t-if="state.loadAvg">
                  <div class="res__load-row">
                    <span class="res__load-label">Load avg</span>
                    <span class="res__load-entry">
                      <span class="res__load-val" t-esc="state.loadAvg.l1.toFixed(2)" />
                      <span class="res__load-period"> 1m</span>
                    </span>
                    <span class="res__load-entry">
                      <span class="res__load-val" t-esc="state.loadAvg.l5.toFixed(2)" />
                      <span class="res__load-period"> 5m</span>
                    </span>
                    <span class="res__load-entry">
                      <span class="res__load-val" t-esc="state.loadAvg.l15.toFixed(2)" />
                      <span class="res__load-period"> 15m</span>
                    </span>
                  </div>
                </t>
              </div>
            </t>

            <!-- Températures -->
            <div class="res__section" t-if="state.temps.length > 0 or state.status === 'done'">
              <div class="res__section-title">Températures</div>
              <t t-if="state.temps.length === 0">
                <div class="res__empty">sensors non disponible ou aucun capteur détecté.</div>
              </t>
              <t t-foreach="sensorsByChip" t-as="group" t-key="group.chip">
                <div class="res__temp-chip">
                  <div class="res__temp-chip-name" t-esc="group.chip" />
                  <t t-foreach="group.sensors" t-as="s" t-key="s.chip + s.label">
                    <div class="res__temp-row">
                      <span class="res__temp-label" t-esc="s.label" />
                      <span class="res__temp-val"
                            t-att-style="'color:' + tempColor(s)"
                            t-esc="s.tempC.toFixed(1) + '°C'" />
                    </div>
                  </t>
                </div>
              </t>
            </div>

            <!-- Réseau -->
            <div class="res__section">
              <div class="res__section-title">Réseau</div>
              <t t-if="state.net">
                <div class="res__net-row">
                  <span class="res__net-label res__net-label--rx">↓ Téléchargement</span>
                  <span class="res__net-val" t-esc="fmtSpeed(state.net.rxBytesPerSec)" />
                </div>
                <div class="res__net-row">
                  <span class="res__net-label res__net-label--tx">↑ Envoi</span>
                  <span class="res__net-val" t-esc="fmtSpeed(state.net.txBytesPerSec)" />
                </div>
              </t>
              <div t-else="" class="res__empty">Données réseau indisponibles.</div>
            </div>

            <!-- Disques -->
            <div class="res__section">
              <div class="res__section-title">Disques</div>
              <t t-if="state.disks.length === 0">
                <div class="res__empty">Aucune partition détectée.</div>
              </t>
              <t t-foreach="state.disks" t-as="disk" t-key="disk.mount + disk.filesystem">
                <div class="res__disk">
                  <div class="res__disk-header">
                    <span class="res__disk-mount" t-esc="disk.mount" />
                    <span t-if="disk.encrypted" class="res__disk-badge res__disk-badge--crypt">🔒 chiffré</span>
                    <span class="res__disk-fs" t-esc="disk.filesystem" />
                  </div>
                  <div class="res__bar-row">
                    <div class="res__bar">
                      <div class="res__bar-fill"
                           t-att-style="'width:' + disk.usePct + '%;background-color:' + barColor(disk.usePct)" />
                    </div>
                    <span class="res__bar-pct" t-esc="disk.usePct + '%'" />
                  </div>
                  <div class="res__metrics">
                    <span class="res__metric">Taille <span class="res__val" t-esc="disk.size" /></span>
                    <span class="res__metric">Utilisé <span class="res__val" t-esc="disk.used" /></span>
                    <span class="res__metric">Libre <span class="res__val res__val--ok" t-esc="disk.avail" /></span>
                  </div>
                </div>
              </t>
            </div>

            <!-- Disponibilité -->
            <div class="res__section">
              <div class="res__section-title">Disponibilité</div>
              <t t-if="state.uptime !== null">
                <div class="res__uptime">
                  <span class="res__uptime-label">En ligne depuis</span>
                  <span class="res__uptime-val" t-esc="fmtUptime(state.uptime)" />
                </div>
              </t>
              <div t-else="" class="res__empty">Uptime indisponible.</div>
            </div>

            <!-- Utilisateurs connectés -->
            <div class="res__section">
              <div class="res__section-title">Utilisateurs connectés</div>
              <t t-if="state.users.length === 0">
                <div class="res__empty">Aucun utilisateur connecté.</div>
              </t>
              <div class="res__users" t-if="state.users.length > 0">
                <t t-foreach="state.users" t-as="u" t-key="u.username">
                  <div class="res__user">
                    <span class="res__user-name" t-esc="u.username" />
                    <span class="res__user-count" t-esc="'×' + u.count" />
                  </div>
                </t>
              </div>
            </div>

          </div>
        </t>

      </div>
    `;

    static components = { HeadingComponent };

    async setup() {
        const params = this.router.getRouteParams(
            window.location.pathname,
            "/servers/resources/:host/:username"
        );
        const host = decodeURIComponent(params.get("host") ?? "");
        const username = decodeURIComponent(params.get("username") ?? "");

        this.state = useState({
            server:       null as Server | null,
            status:       "idle" as "idle" | "loading" | "done" | "error",
            errorMessage: "",
            updatedAt:    "",
            mem:          null as MemInfo | null,
            cpu:          null as CpuInfo | null,
            loadAvg:      null as { l1: number; l5: number; l15: number } | null,
            net:          null as NetInfo | null,
            uptime:       null as number | null,
            disks:        [] as DiskPartition[],
            temps:        [] as TempSensor[],
            users:        [] as UserCount[],
        });

        try {
            const server = await this.serverService.getMatch({ host, username });
            this.state.server = server;
            await this.refresh();
        } catch (error: unknown) {
            this.state.status = "error";
            this.state.errorMessage = error instanceof Error
                ? error.message
                : "Serveur introuvable.";
        }
    }

    // ── Breadcrumbs ───────────────────────────────────────────────────────────

    get breadcrumbs() {
        const crumbs: { label: string; url: string }[] = [
            { label: "Applications", url: "/applications" },
        ];
        const s = this.state.server;
        if (s) {
            const h = encodeURIComponent(s.host);
            const u = encodeURIComponent(s.username);
            crumbs.push({ label: s.label || s.host, url: `/servers/settings/${h}/${u}` });
        }
        return crumbs;
    }

    // ── Computed ──────────────────────────────────────────────────────────────

    get memTrulyUsedPct(): number {
        const m = this.state.mem;
        if (!m || m.totalKb === 0) return 0;
        return Math.min(100, Math.round(m.trulyUsedKb * 100 / m.totalKb));
    }

    get memCachePct(): number {
        const m = this.state.mem;
        if (!m || m.totalKb === 0) return 0;
        return Math.min(100 - this.memTrulyUsedPct, Math.round(m.cachedKb * 100 / m.totalKb));
    }

    get swapUsedPct(): number {
        const m = this.state.mem;
        if (!m || m.swapTotalKb === 0) return 0;
        return Math.min(100, Math.round((m.swapTotalKb - m.swapFreeKb) * 100 / m.swapTotalKb));
    }

    get cpuUsedPct(): number {
        const c = this.state.cpu;
        if (!c) return 0;
        return Math.min(100, Math.round(c.userPct + c.sysPct + c.ioPct));
    }

    barColor(pct: number): string {
        if (pct >= 85) return "#f44336";
        if (pct >= 60) return "#ff9800";
        return "#4caf50";
    }

    fmtKb(kb: number): string { return fmtKb(kb); }
    fmtSpeed(bps: number): string { return fmtSpeed(bps); }
    fmtUptime(secs: number): string { return fmtUptime(secs); }

    get sensorsByChip(): { chip: string; sensors: TempSensor[] }[] {
        const map = new Map<string, TempSensor[]>();
        for (const s of this.state.temps) {
            if (!map.has(s.chip)) map.set(s.chip, []);
            map.get(s.chip)!.push(s);
        }
        return Array.from(map.entries()).map(([chip, sensors]) => ({ chip, sensors }));
    }

    tempColor(s: TempSensor): string {
        const crit = s.critC ?? 100;
        const high = s.highC ?? 80;
        if (s.tempC >= crit * 0.9) return "#ef5350";
        if (s.tempC >= high * 0.9) return "#ff9800";
        if (s.tempC >= 50)         return "#ffd54f";
        return "#81c784";
    }

    // ── SSH fetch ─────────────────────────────────────────────────────────────

    async refresh(): Promise<void> {
        const server = this.state.server;
        if (!server) return;

        this.state.status = "loading";
        const collected: string[] = [];
        let listener: PluginListenerHandle | null = null;

        try {
            const credential = server.authType === "password"
                ? server.password
                : server.privateKey;

            await SshPlugin.connect({
                host: server.host,
                port: server.port,
                username: server.username,
                authType: server.authType,
                credential,
                passphrase: server.passphrase || undefined,
            });

            listener = await SshPlugin.addListener("sshOutput", (data) => {
                if (data.stream === "stdout") collected.push(data.line);
            });

            await SshPlugin.execute({
                command: [
                    "echo '==MEM=='",
                    "grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SReclaimable|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null",
                    "echo '==CPU=='",
                    "TERM=dumb top -bn1 2>/dev/null | grep -m1 -iE '%?cpu'",
                    "echo '==LOAD=='",
                    "cat /proc/loadavg 2>/dev/null",
                    "echo '==TEMPS=='",
                    "sensors 2>/dev/null || true",
                    "echo '==DISK=='",
                    "df -hP 2>/dev/null | grep -vE '^(Filesystem|tmpfs|devtmpfs|udev|overlay|shm|squashfs)'",
                    "echo '==CRYPT=='",
                    "lsblk -lno TYPE,NAME,MOUNTPOINT 2>/dev/null | grep '^crypt' | while read type name mp; do [ -n \"$mp\" ] && echo \"$mp\"; lsblk -lno MOUNTPOINT /dev/mapper/$name 2>/dev/null | grep '^/'; done; true",
                    "echo '==NET1=='",
                    "cat /proc/net/dev",
                    "sleep 1",
                    "echo '==NET2=='",
                    "cat /proc/net/dev",
                    "echo '==UPTIME=='",
                    "cat /proc/uptime 2>/dev/null",
                    "echo '==USERS=='",
                    "users 2>/dev/null; true",
                    "echo '==END=='",
                ].join("; "),
            });

            if (listener) { await listener.remove(); listener = null; }

            // Split into sections
            const sections: Record<string, string[]> = {
                MEM: [], CPU: [], LOAD: [], TEMPS: [], DISK: [], CRYPT: [],
                NET1: [], NET2: [], UPTIME: [], USERS: [],
            };
            let cur = "";
            for (const line of collected) {
                const t = line.trim();
                if      (t === "==MEM==")    { cur = "MEM";    continue; }
                else if (t === "==CPU==")    { cur = "CPU";    continue; }
                else if (t === "==LOAD==")   { cur = "LOAD";   continue; }
                else if (t === "==TEMPS==")  { cur = "TEMPS";  continue; }
                else if (t === "==DISK==")   { cur = "DISK";   continue; }
                else if (t === "==CRYPT==")  { cur = "CRYPT";  continue; }
                else if (t === "==NET1==")   { cur = "NET1";   continue; }
                else if (t === "==NET2==")   { cur = "NET2";   continue; }
                else if (t === "==UPTIME==") { cur = "UPTIME"; continue; }
                else if (t === "==USERS==")  { cur = "USERS";  continue; }
                else if (t === "==END==")    { cur = "";        continue; }
                if (cur) sections[cur].push(line);
            }

            const cryptMounts = parseCryptMounts(sections.CRYPT);

            this.state.mem     = parseMem(sections.MEM);
            this.state.cpu     = parseCpu(sections.CPU[0] || "");
            this.state.loadAvg = parseLoad(sections.LOAD[0] || "");
            this.state.temps   = parseSensors(sections.TEMPS);
            this.state.disks   = parseDisk(sections.DISK, cryptMounts);
            this.state.net     = parseNet(sections.NET1, sections.NET2);
            this.state.uptime  = parseUptime(sections.UPTIME[0] || "");
            this.state.users   = parseUsers(sections.USERS.join(" "));

            const now = new Date();
            this.state.updatedAt = "Mis à jour " + now.toTimeString().slice(0, 8);
            this.state.status = "done";

        } catch (error: unknown) {
            this.state.status = "error";
            this.state.errorMessage = error instanceof Error ? error.message : "Erreur SSH.";
        } finally {
            if (listener) await listener.remove().catch(() => {});
            try { await SshPlugin.disconnect(); } catch (_e) {}
        }
    }
}
