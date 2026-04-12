import { onMounted, onWillDestroy, useState, xml } from "@odoo/owl";
import { Capacitor } from "@capacitor/core";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { HeadingComponent } from "../../heading/heading_component";
import { DeviceStatsPlugin } from "../../../plugins/deviceStatsPlugin";
import type { DeviceStats } from "../../../plugins/deviceStatsPlugin";

// ── Constants ─────────────────────────────────────────────────────────────────

const HISTORY_LEN  = 60;   // samples kept in circular buffer
const CHART_W      = 200;
const CHART_H      = 50;
const REFRESH_OPTS = [1, 5, 30] as const;

type RefreshSec = typeof REFRESH_OPTS[number];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
    if (b < 1_024)           return b.toFixed(0) + " o";
    if (b < 1_048_576)       return (b / 1_024).toFixed(1) + " Ko";
    if (b < 1_073_741_824)   return (b / 1_048_576).toFixed(1) + " Mo";
    return (b / 1_073_741_824).toFixed(2) + " Go";
}

function fmtSpeed(b: number): string {
    return fmtBytes(b) + "/s";
}

function fmtPct(n: number): string {
    return n.toFixed(1) + " %";
}

// ── Component ─────────────────────────────────────────────────────────────────

export class OptionsResourcesComponent extends EnhancedComponent {
    static template = xml`
        <div id="options-resources-component">
            <HeadingComponent title="'Options › Ressources'" backUrl="'/options'" />

            <div class="devres__body">

                <!-- Not available on web -->
                <t t-if="!isNative">
                    <p class="devres__unavailable">
                        Le moniteur de ressources n'est disponible que sur l'application mobile Android.
                    </p>
                </t>

                <t t-if="isNative">

                    <!-- ── Refresh rate selector ────────────────────── -->
                    <div class="devres__rate-section">
                        <div class="devres__rate-header">
                            <span class="devres__rate-title">Rafraîchissement</span>
                            <span class="devres__updated" t-if="state.updatedAt" t-esc="state.updatedAt" />
                        </div>
                        <div class="devres__rate-list">
                            <button class="devres__rate-row"
                                    t-att-class="{'devres__rate-row--active': state.refreshSec === 1}"
                                    data-sec="1"
                                    t-on-click="onRateClick">
                                <span class="devres__rate-dot"></span>
                                <span class="devres__rate-label">1 seconde</span>
                                <span class="devres__rate-check">✓</span>
                            </button>
                            <button class="devres__rate-row"
                                    t-att-class="{'devres__rate-row--active': state.refreshSec === 5}"
                                    data-sec="5"
                                    t-on-click="onRateClick">
                                <span class="devres__rate-dot"></span>
                                <span class="devres__rate-label">5 secondes</span>
                                <span class="devres__rate-check">✓</span>
                            </button>
                            <button class="devres__rate-row"
                                    t-att-class="{'devres__rate-row--active': state.refreshSec === 30}"
                                    data-sec="30"
                                    t-on-click="onRateClick">
                                <span class="devres__rate-dot"></span>
                                <span class="devres__rate-label">30 secondes</span>
                                <span class="devres__rate-check">✓</span>
                            </button>
                        </div>
                    </div>

                    <t t-if="state.error">
                        <div class="devres__error" t-esc="state.error" />
                    </t>

                    <!-- ── RAM ─────────────────────────────────────── -->
                    <div class="devres__card">
                        <div class="devres__card-header">
                            <span class="devres__card-title">RAM</span>
                            <span class="devres__card-pct devres__card-pct--ram"
                                  t-esc="fmtPct(state.ramPct)" />
                        </div>
                        <div class="devres__bar">
                            <div class="devres__bar-fill devres__bar-fill--ram"
                                 t-att-style="'width:' + state.ramPct + '%'" />
                        </div>
                        <div class="devres__metrics">
                            <span><span class="devres__label">Utilisée</span>
                                  <span class="devres__val" t-esc="fmtBytes(state.ramUsed)" /></span>
                            <span><span class="devres__label">Libre</span>
                                  <span class="devres__val devres__val--ok" t-esc="fmtBytes(state.ramAvail)" /></span>
                            <span><span class="devres__label">Total</span>
                                  <span class="devres__val" t-esc="fmtBytes(state.ramTotal)" /></span>
                        </div>
                        <svg class="devres__chart devres__chart--ram"
                             viewBox="0 0 200 50" preserveAspectRatio="none">
                            <polygon class="devres__chart-area devres__chart-area--ram"
                                     t-att-points="chartArea(state.ramHistory, 100)" />
                            <polyline class="devres__chart-line devres__chart-line--ram"
                                      fill="none"
                                      t-att-points="chartLine(state.ramHistory, 100)" />
                        </svg>
                    </div>

                    <!-- ── CPU ─────────────────────────────────────── -->
                    <div class="devres__card">
                        <div class="devres__card-header">
                            <span class="devres__card-title">CPU</span>
                            <span class="devres__card-pct devres__card-pct--cpu"
                                  t-esc="fmtPct(state.cpuPct)" />
                        </div>
                        <div class="devres__bar">
                            <div class="devres__bar-fill devres__bar-fill--cpu"
                                 t-att-style="'width:' + state.cpuPct + '%'" />
                        </div>
                        <svg class="devres__chart devres__chart--cpu"
                             viewBox="0 0 200 50" preserveAspectRatio="none">
                            <polygon class="devres__chart-area devres__chart-area--cpu"
                                     t-att-points="chartArea(state.cpuHistory, 100)" />
                            <polyline class="devres__chart-line devres__chart-line--cpu"
                                      fill="none"
                                      t-att-points="chartLine(state.cpuHistory, 100)" />
                        </svg>
                    </div>

                    <!-- ── Réseau ───────────────────────────────────── -->
                    <div class="devres__card">
                        <div class="devres__card-header">
                            <span class="devres__card-title">Réseau</span>
                        </div>
                        <div class="devres__net-row">
                            <div class="devres__net-col">
                                <span class="devres__net-dir">↓ Téléch.</span>
                                <span class="devres__net-val devres__net-val--rx"
                                      t-esc="fmtSpeed(state.netRx)" />
                            </div>
                            <div class="devres__net-col">
                                <span class="devres__net-dir">↑ Envoi</span>
                                <span class="devres__net-val devres__net-val--tx"
                                      t-esc="fmtSpeed(state.netTx)" />
                            </div>
                        </div>
                        <!-- Download chart -->
                        <span class="devres__chart-label">↓ <t t-esc="netPeakLabel(state.netRxHistory)" /></span>
                        <svg class="devres__chart devres__chart--rx"
                             viewBox="0 0 200 50" preserveAspectRatio="none">
                            <polygon class="devres__chart-area devres__chart-area--rx"
                                     t-att-points="chartArea(state.netRxHistory, netPeak(state.netRxHistory))" />
                            <polyline class="devres__chart-line devres__chart-line--rx"
                                      fill="none"
                                      t-att-points="chartLine(state.netRxHistory, netPeak(state.netRxHistory))" />
                        </svg>
                        <!-- Upload chart -->
                        <span class="devres__chart-label">↑ <t t-esc="netPeakLabel(state.netTxHistory)" /></span>
                        <svg class="devres__chart devres__chart--tx"
                             viewBox="0 0 200 50" preserveAspectRatio="none">
                            <polygon class="devres__chart-area devres__chart-area--tx"
                                     t-att-points="chartArea(state.netTxHistory, netPeak(state.netTxHistory))" />
                            <polyline class="devres__chart-line devres__chart-line--tx"
                                      fill="none"
                                      t-att-points="chartLine(state.netTxHistory, netPeak(state.netTxHistory))" />
                        </svg>
                    </div>

                </t>
            </div>
        </div>
    `;

    static components = { HeadingComponent };

    private _timer: ReturnType<typeof setInterval> | null = null;

    setup() {
        const emptyHistory = (): number[] => Array(HISTORY_LEN).fill(0);

        this.state = useState({
            refreshSec:    5 as RefreshSec,
            updatedAt:     "",
            error:         "",
            // Current values
            ramTotal:      0,
            ramUsed:       0,
            ramAvail:      0,
            ramPct:        0,
            cpuPct:        0,
            netRx:         0,
            netTx:         0,
            // History
            ramHistory:    emptyHistory(),
            cpuHistory:    emptyHistory(),
            netRxHistory:  emptyHistory(),
            netTxHistory:  emptyHistory(),
        });

        onMounted(async () => {
            await this.tick();              // immediate first read
            this.startTimer();
        });

        onWillDestroy(() => this.stopTimer());
    }

    // ── Getters ───────────────────────────────────────────────────────────────

    get isNative(): boolean {
        return Capacitor.isNativePlatform();
    }

    // ── Polling ───────────────────────────────────────────────────────────────

    private startTimer() {
        this.stopTimer();
        this._timer = setInterval(
            () => this.tick(),
            this.state.refreshSec * 1_000
        );
    }

    private stopTimer() {
        if (this._timer !== null) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    onRateClick(ev: MouseEvent): void {
        const raw = (ev.currentTarget as HTMLElement).dataset.sec;
        const sec = parseInt(raw ?? "5", 10) as RefreshSec;
        this.setRefreshRate(sec);
    }

    async setRefreshRate(sec: RefreshSec) {
        this.state.refreshSec = sec;
        this.startTimer();
    }

    private async tick() {
        try {
            const s: DeviceStats = await DeviceStatsPlugin.getStats();
            this.state.error   = "";
            this.state.ramTotal = s.ramTotal;
            this.state.ramUsed  = s.ramUsed;
            this.state.ramAvail = s.ramAvail;
            this.state.ramPct   = s.ramPct;
            this.state.cpuPct   = s.cpuPct;
            this.state.netRx    = s.netRxBytesPerSec;
            this.state.netTx    = s.netTxBytesPerSec;

            this.pushHistory(this.state.ramHistory,   s.ramPct);
            this.pushHistory(this.state.cpuHistory,   s.cpuPct);
            this.pushHistory(this.state.netRxHistory, s.netRxBytesPerSec);
            this.pushHistory(this.state.netTxHistory, s.netTxBytesPerSec);

            const now = new Date();
            this.state.updatedAt = now.toLocaleTimeString("fr-CA");
        } catch (e: unknown) {
            this.state.error = "Erreur : " + (e instanceof Error ? e.message : String(e));
        }
    }

    private pushHistory(arr: number[], value: number) {
        arr.push(value);
        if (arr.length > HISTORY_LEN) arr.shift();
    }

    // ── Chart helpers ─────────────────────────────────────────────────────────

    /** SVG polyline points string for the sparkline line. */
    chartLine(values: number[], vMax: number): string {
        if (values.length < 2 || vMax <= 0) return "";
        const n = values.length;
        return values.map((v, i) => {
            const x = (i / (n - 1)) * CHART_W;
            const y = CHART_H - Math.min(v, vMax) / vMax * CHART_H;
            return `${x.toFixed(1)},${y.toFixed(2)}`;
        }).join(" ");
    }

    /** SVG polygon points string for the filled area under the chart. */
    chartArea(values: number[], vMax: number): string {
        const line = this.chartLine(values, vMax);
        if (!line) return "";
        return `${line} ${CHART_W},${CHART_H} 0,${CHART_H}`;
    }

    /** Dynamic peak value for network charts (used as scale denominator). */
    netPeak(history: number[]): number {
        return Math.max(...history, 1_024); // floor 1 KB/s so scale is never 0
    }

    /** Label showing the current peak scale. */
    netPeakLabel(history: number[]): string {
        return "pic " + fmtSpeed(this.netPeak(history));
    }

    // ── Template helpers exposed to OWL ───────────────────────────────────────

    fmtBytes(b: number): string { return fmtBytes(b); }
    fmtSpeed(b: number): string { return fmtSpeed(b); }
    fmtPct(n: number):   string { return fmtPct(n); }
}
