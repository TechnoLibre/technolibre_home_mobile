import { useState, xml } from "@odoo/owl";
import type { PluginListenerHandle } from "@capacitor/core";

import { Server } from "../../../models/server";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { HeadingComponent } from "../../heading/heading_component";
import { SshPlugin } from "../../../plugins/sshPlugin";

// ── Data types ────────────────────────────────────────────────────────────────

interface MemInfo {
    totalKb: number;
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
}

interface UserCount {
    username: string;
    count: number;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

function fmtKb(kb: number): string {
    if (kb >= 1024 * 1024) return (kb / 1024 / 1024).toFixed(1) + " GB";
    if (kb >= 1024) return Math.round(kb / 1024) + " MB";
    return kb + " KB";
}

function parseMem(lines: string[]): MemInfo {
    const map: Record<string, number> = {};
    for (const line of lines) {
        const m = line.match(/^(\w+):\s+(\d+)/);
        if (m) map[m[1]] = parseInt(m[2], 10);
    }
    return {
        totalKb:     map["MemTotal"]     || 0,
        availableKb: map["MemAvailable"] || map["MemFree"] || 0,
        swapTotalKb: map["SwapTotal"]    || 0,
        swapFreeKb:  map["SwapFree"]     || 0,
    };
}

function parseCpu(line: string): CpuInfo | null {
    if (!line) return null;
    const get = (key: string): number => {
        const m = line.match(new RegExp("([\\d.]+)[%\\s]+" + key));
        return m ? parseFloat(m[1]) : 0;
    };
    return {
        userPct: get("us"),
        sysPct:  get("sy"),
        ioPct:   get("wa"),
        idlePct: get("id"),
    };
}

function parseDisk(lines: string[]): DiskPartition[] {
    const result: DiskPartition[] = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 6) continue;
        if (parts[0] === "Filesystem") continue;
        const pct = parseInt(parts[4].replace("%", ""), 10) || 0;
        result.push({
            filesystem: parts[0],
            size:  parts[1],
            used:  parts[2],
            avail: parts[3],
            usePct: pct,
            mount: parts.slice(5).join(" "),
        });
    }
    return result;
}

function parseUsers(line: string): UserCount[] {
    const names = (line || "").trim().split(/\s+/).filter(Boolean);
    const counts: Record<string, number> = {};
    for (const name of names) counts[name] = (counts[name] || 0) + 1;
    return Object.entries(counts)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([username, count]) => ({ username, count }));
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
                    <div class="res__bar-fill"
                         t-att-style="'width:' + memUsedPct + '%;background-color:' + barColor(memUsedPct)" />
                  </div>
                  <span class="res__bar-pct" t-esc="memUsedPct + '%'" />
                </div>
                <div class="res__metrics">
                  <span class="res__metric">Total <span class="res__val" t-esc="fmtKb(state.mem.totalKb)" /></span>
                  <span class="res__metric">Utilisée <span class="res__val" t-esc="fmtKb(state.mem.totalKb - state.mem.availableKb)" /></span>
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
              </div>
            </t>

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
            disks:        [] as DiskPartition[],
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

    get memUsedPct(): number {
        const m = this.state.mem;
        if (!m || m.totalKb === 0) return 0;
        return Math.min(100, Math.round((m.totalKb - m.availableKb) * 100 / m.totalKb));
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

    fmtKb(kb: number): string {
        return fmtKb(kb);
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

            // One combined command; sections delimited by markers
            await SshPlugin.execute({
                command: [
                    "echo '==MEM=='",
                    "grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null",
                    "echo '==CPU=='",
                    "TERM=dumb top -bn1 2>/dev/null | grep -m1 -iE '%?cpu'",
                    "echo '==DISK=='",
                    "df -hP 2>/dev/null | grep -vE '^(Filesystem|tmpfs|devtmpfs|udev|overlay|shm|squashfs)'",
                    "echo '==USERS=='",
                    "users 2>/dev/null; true",
                    "echo '==END=='",
                ].join("; "),
            });

            if (listener) { await listener.remove(); listener = null; }

            // Split into sections
            const sections: Record<string, string[]> = { MEM: [], CPU: [], DISK: [], USERS: [] };
            let cur = "";
            for (const line of collected) {
                const t = line.trim();
                if (t === "==MEM==")   { cur = "MEM";   continue; }
                if (t === "==CPU==")   { cur = "CPU";   continue; }
                if (t === "==DISK==")  { cur = "DISK";  continue; }
                if (t === "==USERS==") { cur = "USERS"; continue; }
                if (t === "==END==")   { cur = "";      continue; }
                if (cur) sections[cur].push(line);
            }

            this.state.mem   = parseMem(sections.MEM);
            this.state.cpu   = parseCpu(sections.CPU[0] || "");
            this.state.disks = parseDisk(sections.DISK);
            this.state.users = parseUsers(sections.USERS.join(" "));

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
