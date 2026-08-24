import { useState, xml } from "@odoo/owl";
import type { PluginListenerHandle } from "@capacitor/core";

import { Server } from "../../../models/server";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { HeadingComponent } from "../../heading/heading_component";
import { SshPlugin } from "../../../plugins/sshPlugin";
import {
    type MemInfo, type CpuInfo, type DiskPartition, type NetInfo,
    type UserCount, type TempSensor,
    fmtKb, fmtSpeed, fmtUptime,
    parseMem, parseCpu, parseLoad, parseCryptMounts, parseDisk,
    parseNet, parseUptime, parseUsers, parseSensors,
} from "../../../utils/serverResourceParsers";

// ── Component ─────────────────────────────────────────────────────────────────

export class ServersResourcesComponent extends EnhancedComponent {
    static template = xml`
      <div id="servers-resources-component">
        <HeadingComponent title="t('heading.resources')" breadcrumbs="breadcrumbs" />

        <!-- ── Toolbar ─────────────────────────────────────────── -->
        <div class="res__toolbar">
          <button class="res__btn-refresh"
                  t-att-disabled="state.status === 'loading'"
                  t-on-click="() => this.refresh()">
            <t t-if="state.status === 'loading'">
              <span class="res__spinner">◌</span> Chargement…
            </t>
            <t t-else="">↻ <t t-esc="t('button.refresh_resources')"/></t>
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
                <div class="res__section-title"><t t-esc="t('section.ram')"/></div>
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
                  <span class="res__metric"><t t-esc="t('label.total')"/><span class="res__val" t-esc="fmtKb(state.mem.totalKb)" /></span>
                  <span class="res__metric"><span class="res__legend res__legend--used"></span><t t-esc="t('label.used_f')"/><span class="res__val" t-esc="fmtKb(state.mem.trulyUsedKb)" /></span>
                  <span class="res__metric"><span class="res__legend res__legend--cache"></span><t t-esc="t('label.cache')"/><span class="res__val res__val--cache" t-esc="fmtKb(state.mem.cachedKb)" /></span>
                  <span class="res__metric"><t t-esc="t('label.available')"/><span class="res__val res__val--ok" t-esc="fmtKb(state.mem.availableKb)" /></span>
                </div>
              </div>
            </t>

            <!-- Swap -->
            <t t-if="state.mem">
              <div class="res__section">
                <div class="res__section-title"><t t-esc="t('section.swap')"/></div>
                <t t-if="state.mem.swapTotalKb === 0">
                  <div class="res__empty"><t t-esc="t('message.no_swap')"/></div>
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
                    <span class="res__metric"><t t-esc="t('label.total')"/><span class="res__val" t-esc="fmtKb(state.mem.swapTotalKb)" /></span>
                    <span class="res__metric"><t t-esc="t('label.used_m')"/><span class="res__val" t-esc="fmtKb(state.mem.swapTotalKb - state.mem.swapFreeKb)" /></span>
                    <span class="res__metric"><t t-esc="t('label.free')"/><span class="res__val res__val--ok" t-esc="fmtKb(state.mem.swapFreeKb)" /></span>
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
                  <span class="res__metric"><t t-esc="t('label.cpu_user')"/><span class="res__val" t-esc="state.cpu.userPct.toFixed(1) + '%'" /></span>
                  <span class="res__metric"><t t-esc="t('label.cpu_system')"/><span class="res__val" t-esc="state.cpu.sysPct.toFixed(1) + '%'" /></span>
                  <span class="res__metric"><t t-esc="t('label.cpu_iowait')"/><span class="res__val" t-esc="state.cpu.ioPct.toFixed(1) + '%'" /></span>
                  <span class="res__metric"><t t-esc="t('label.cpu_idle')"/><span class="res__val res__val--ok" t-esc="state.cpu.idlePct.toFixed(1) + '%'" /></span>
                </div>
                <t t-if="state.loadAvg">
                  <div class="res__load-row">
                    <span class="res__load-label"><t t-esc="t('label.load_avg')"/></span>
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
              <div class="res__section-title"><t t-esc="t('section.temperatures')"/></div>
              <t t-if="state.temps.length === 0">
                <div class="res__empty"><t t-esc="t('message.no_sensors')"/></div>
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
              <div class="res__section-title"><t t-esc="t('section.network')"/></div>
              <t t-if="state.net">
                <div class="res__net-row">
                  <span class="res__net-label res__net-label--rx">↓ <t t-esc="t('label.download')"/></span>
                  <span class="res__net-val" t-esc="fmtSpeed(state.net.rxBytesPerSec)" />
                </div>
                <div class="res__net-row">
                  <span class="res__net-label res__net-label--tx">↑ <t t-esc="t('label.upload')"/></span>
                  <span class="res__net-val" t-esc="fmtSpeed(state.net.txBytesPerSec)" />
                </div>
              </t>
              <div t-else="" class="res__empty"><t t-esc="t('message.no_network_data')"/></div>
            </div>

            <!-- Disques -->
            <div class="res__section">
              <div class="res__section-title"><t t-esc="t('section.disks')"/></div>
              <t t-if="state.disks.length === 0">
                <div class="res__empty"><t t-esc="t('message.no_partition')"/></div>
              </t>
              <t t-foreach="state.disks" t-as="disk" t-key="disk.mount + disk.filesystem">
                <div class="res__disk">
                  <div class="res__disk-header">
                    <span class="res__disk-mount" t-esc="disk.mount" />
                    <span t-if="disk.encrypted" class="res__disk-badge res__disk-badge--crypt">🔒 <t t-esc="t('label.encrypted_disk')"/></span>
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
                    <span class="res__metric"><t t-esc="t('label.marian_size')"/><span class="res__val" t-esc="disk.size" /></span>
                    <span class="res__metric"><t t-esc="t('label.used_m')"/><span class="res__val" t-esc="disk.used" /></span>
                    <span class="res__metric"><t t-esc="t('label.free')"/><span class="res__val res__val--ok" t-esc="disk.avail" /></span>
                  </div>
                </div>
              </t>
            </div>

            <!-- Disponibilité -->
            <div class="res__section">
              <div class="res__section-title"><t t-esc="t('section.uptime')"/></div>
              <t t-if="state.uptime !== null">
                <div class="res__uptime">
                  <span class="res__uptime-label"><t t-esc="t('label.online_since')"/></span>
                  <span class="res__uptime-val" t-esc="fmtUptime(state.uptime)" />
                </div>
              </t>
              <div t-else="" class="res__empty"><t t-esc="t('message.no_uptime')"/></div>
            </div>

            <!-- Utilisateurs connectés -->
            <div class="res__section">
              <div class="res__section-title"><t t-esc="t('section.logged_users')"/></div>
              <t t-if="state.users.length === 0">
                <div class="res__empty"><t t-esc="t('message.no_logged_user')"/></div>
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
