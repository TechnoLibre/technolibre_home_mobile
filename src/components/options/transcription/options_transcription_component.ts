import { onMounted, onWillDestroy, useState, xml } from "@odoo/owl";
import { Capacitor } from "@capacitor/core";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { HeadingComponent } from "../../heading/heading_component";
import type { WhisperModel } from "../../../plugins/whisperPlugin";
import type { DownloadProgress } from "../../../services/transcriptionService";
import type { ProcessRecord } from "../../../models/process";

interface ModelDef {
    key:          WhisperModel;
    name:         string;
    size:         string;
    ram:          string;
    speedDots:    number;   // 1–5
    speedLabel:   string;
    qualityDots:  number;   // 1–5
    qualityLabel: string;
    desc:         string;
    recommended?: boolean;
    heavy?:       boolean;  // warn about RAM on low-end devices
    englishOnly?: boolean;  // warn that model does not support French
}

const ALL_MODELS: ModelDef[] = [
    {
        key:          "tiny",
        name:         "Tiny",
        size:         "~75 Mo",
        ram:          "~125 Mo",
        speedDots:    5,
        speedLabel:   "Très rapide",
        qualityDots:  3,
        qualityLabel: "Correcte",
        desc:         "Idéal pour tester ou transcrire du français clair et articulé.",
    },
    {
        key:          "base",
        name:         "Base",
        size:         "~142 Mo",
        ram:          "~210 Mo",
        speedDots:    4,
        speedLabel:   "Rapide",
        qualityDots:  4,
        qualityLabel: "Bonne",
        desc:         "Meilleur équilibre vitesse / précision pour la majorité des usages.",
        recommended:  true,
    },
    {
        key:          "small",
        name:         "Small",
        size:         "~244 Mo",
        ram:          "~440 Mo",
        speedDots:    3,
        speedLabel:   "Moyen",
        qualityDots:  4,
        qualityLabel: "Bonne",
        desc:         "Gère mieux les accents et le bruit de fond que Base.",
    },
    {
        key:          "medium",
        name:         "Medium",
        size:         "~769 Mo",
        ram:          "~1,5 Go",
        speedDots:    2,
        speedLabel:   "Lent",
        qualityDots:  5,
        qualityLabel: "Excellente",
        desc:         "Très haute précision pour du contenu technique ou des accents marqués.",
        heavy:        true,
    },
    {
        key:          "large-v3-turbo",
        name:         "Large-v3-turbo",
        size:         "~874 Mo",
        ram:          "~1,6 Go",
        speedDots:    3,
        speedLabel:   "Moyen",
        qualityDots:  5,
        qualityLabel: "Excellente",
        desc:         "Meilleure qualité disponible en local. Plus rapide que Medium pour une précision identique.",
        heavy:        true,
    },
    {
        key:          "distil-large-v3",
        name:         "Distil-large-v3",
        size:         "~756 Mo",
        ram:          "~1,2 Go",
        speedDots:    4,
        speedLabel:   "Rapide",
        qualityDots:  1,
        qualityLabel: "Anglais seul",
        desc:         "⚠ Anglais uniquement — ne transcrit pas le français. Optimisé pour l'anglais avec une vitesse élevée.",
        heavy:        true,
        englishOnly:  true,
    },
];

/** Render n filled + (max-n) empty dots. */
function dots(n: number, max: number, filled: string, empty: string): string {
    return filled.repeat(n) + empty.repeat(max - n);
}

export class OptionsTranscriptionComponent extends EnhancedComponent {
    static template = xml`
        <div id="options-transcription-component">
            <HeadingComponent title="'Options › Transcription'" backUrl="'/options'" />

            <div class="transcription-body">

                <!-- Not available on web -->
                <p t-if="!isNative" class="transcription-unavailable">
                    La transcription audio n'est disponible que sur l'application mobile Android.
                </p>

                <t t-if="isNative">

                    <!-- ── Enable / disable ─────────────────────────────────── -->
                    <div class="transcription-row transcription-row--toggle">
                        <div class="transcription-row__label">
                            <span class="transcription-row__title">🎙️ Transcription audio</span>
                            <span class="transcription-row__desc">
                                Convertit les enregistrements audio en texte via Whisper —
                                entièrement local, aucun serveur, aucun abonnement.
                            </span>
                        </div>
                        <div class="transcription-toggle-wrap">
                            <span
                                class="transcription-toggle-state"
                                t-att-class="{ 'transcription-toggle-state--on': state.enabled }"
                                t-esc="state.enabled ? 'Activée' : 'Désactivée'"
                            />
                            <label class="transcription-switch">
                                <input type="checkbox"
                                    t-att-checked="state.enabled"
                                    t-on-change="onToggleEnabled"
                                />
                                <span class="transcription-switch__slider" />
                            </label>
                        </div>
                    </div>

                    <t t-if="state.enabled">

                        <!-- ── Groq cloud (alternative to local whisper.cpp) ── -->
                        <div class="transcription-section">
                            <p class="transcription-section__title">☁️ Groq (cloud)</p>
                            <p class="transcription-section__hint">
                                Si activé, les transcriptions sont envoyées à
                                l'API Groq (whisper-large-v3) au lieu du modèle
                                local. Plus rapide et précis, mais nécessite
                                une connexion réseau et une clé API
                                <a href="https://console.groq.com/keys"
                                   target="_blank" rel="noopener">groq.com</a>.
                                Free tier ≈ 30 req/min.
                            </p>
                            <div class="transcription-row transcription-row--toggle">
                                <div class="transcription-row__label">
                                    <span class="transcription-row__title">
                                        Utiliser Groq Whisper (cloud)
                                    </span>
                                </div>
                                <div class="transcription-toggle-wrap">
                                    <span class="transcription-toggle-state"
                                        t-att-class="{ 'transcription-toggle-state--on': state.groqEnabled }"
                                        t-esc="state.groqEnabled ? 'Activée' : 'Désactivée'"/>
                                    <label class="transcription-switch">
                                        <input type="checkbox"
                                            t-att-checked="state.groqEnabled"
                                            t-on-change="onToggleGroq"/>
                                        <span class="transcription-switch__slider"/>
                                    </label>
                                </div>
                            </div>
                            <t t-if="state.groqEnabled">
                                <div class="transcription-groq-key">
                                    <label for="transcription-groq-key__input">
                                        Clé API Groq
                                    </label>
                                    <input
                                        id="transcription-groq-key__input"
                                        type="password"
                                        autocomplete="off"
                                        autocapitalize="off"
                                        spellcheck="false"
                                        placeholder="gsk_…"
                                        t-att-value="state.groqApiKey"
                                        t-on-change="onGroqKeyChange"
                                        t-on-blur="onGroqKeyChange"/>
                                    <p class="transcription-section__hint" t-if="state.groqEnabled and !state.groqApiKey">
                                        ⚠ Clé manquante — la transcription
                                        retombera sur le modèle local.
                                    </p>
                                </div>
                            </t>
                        </div>

                        <!-- ── Model selector ──────────────────────────────── -->
                        <div class="transcription-section">
                            <p class="transcription-section__title">Modèle Whisper</p>
                            <p class="transcription-section__hint">
                                Sélectionnez un modèle puis téléchargez-le pour activer la transcription.
                            </p>

                            <t t-foreach="models" t-as="m" t-key="m.key">
                                <div
                                    class="transcription-model"
                                    t-att-class="{
                                        'transcription-model--active':       state.selectedModel === m.key,
                                        'transcription-model--recommended':  m.recommended,
                                        'transcription-model--english-only': m.englishOnly,
                                    }"
                                    t-att-data-model-key="m.key"
                                    t-on-click="onModelCardClick"
                                >
                                    <div class="transcription-model__radio" />

                                    <div class="transcription-model__info">

                                        <!-- Header: name + badges -->
                                        <div class="transcription-model__header">
                                            <span class="transcription-model__name" t-esc="m.name" />
                                            <span t-if="m.recommended"
                                                  class="transcription-model__badge transcription-model__badge--recommended">
                                                ★ Recommandé
                                            </span>
                                            <span t-if="m.englishOnly"
                                                  class="transcription-model__badge transcription-model__badge--english-only">
                                                🇬🇧 Anglais uniquement
                                            </span>
                                            <span class="transcription-model__size" t-esc="m.size" />
                                        </div>

                                        <!-- Metrics: speed + quality -->
                                        <div class="transcription-model__metrics">
                                            <span class="transcription-model__metric">
                                                <span class="transcription-model__metric-label">Vitesse</span>
                                                <span class="transcription-model__metric-dots"
                                                      t-esc="speedDots(m)" />
                                                <span class="transcription-model__metric-text"
                                                      t-esc="m.speedLabel" />
                                            </span>
                                            <span class="transcription-model__metric">
                                                <span class="transcription-model__metric-label">Qualité FR</span>
                                                <span class="transcription-model__metric-dots transcription-model__metric-dots--quality"
                                                      t-esc="qualityDots(m)" />
                                                <span class="transcription-model__metric-text"
                                                      t-esc="m.qualityLabel" />
                                            </span>
                                        </div>

                                        <!-- RAM + heavy warning -->
                                        <div class="transcription-model__meta">
                                            <span class="transcription-model__ram">RAM : <t t-esc="m.ram"/></span>
                                            <span t-if="m.heavy" class="transcription-model__heavy">
                                                ⚠ Appareil récent conseillé
                                            </span>
                                        </div>

                                        <!-- Description -->
                                        <span class="transcription-model__desc" t-esc="m.desc" />

                                        <!-- Download status -->
                                        <t t-if="state.downloadedModels[m.key]">
                                            <div class="transcription-model__footer">
                                                <span class="transcription-model__badge transcription-model__badge--ok">✓ Téléchargé</span>
                                                <button class="transcription-model__delete-btn"
                                                        t-att-data-model-key="m.key"
                                                        t-att-disabled="state.isDeleting"
                                                        t-on-click.stop="onModelDeleteClick"
                                                        title="Supprimer">🗑</button>
                                            </div>
                                        </t>
                                        <t t-elif="state.downloadingModels[m.key]">
                                            <div class="transcription-model__footer transcription-model__footer--downloading">
                                                <div class="transcription-progress transcription-progress--sm">
                                                    <div class="transcription-progress__bar"
                                                         t-att-style="'width:' + (state.downloadingModels[m.key].percent || 0) + '%'" />
                                                </div>
                                                <span class="transcription-model__dl-info">
                                                    <t t-esc="state.downloadingModels[m.key].percent || 0"/>%
                                                    <t t-if="state.downloadingModels[m.key].speedBytesPerSec > 0">
                                                        · <t t-esc="formatSpeed(state.downloadingModels[m.key].speedBytesPerSec)"/>
                                                    </t>
                                                </span>
                                                <button class="transcription-model__cancel-btn"
                                                        t-att-data-model-key="m.key"
                                                        t-on-click.stop="onModelCancelClick">✕</button>
                                            </div>
                                        </t>
                                        <t t-else="">
                                            <div class="transcription-model__footer">
                                                <span class="transcription-model__badge transcription-model__badge--pending">À télécharger</span>
                                                <button class="transcription-model__dl-btn"
                                                        t-att-data-model-key="m.key"
                                                        t-on-click.stop="onModelDownloadClick">⬇ Télécharger</button>
                                            </div>
                                        </t>

                                    </div>
                                </div>
                            </t>
                        </div>

                        <!-- ── Download mode toggle ───────────────────────── -->
                        <t t-if="hasUndownloadedModels">
                            <div class="transcription-mode">
                                <p class="transcription-section__title">Mode de téléchargement</p>
                                <div class="transcription-mode__options">
                                    <button
                                        class="transcription-mode__btn"
                                        t-att-class="{'transcription-mode__btn--active': state.downloadMode === 'wakelock'}"
                                        t-on-click="onSetDownloadModeWakelock"
                                    >
                                        🔋 Standard
                                        <span class="transcription-mode__sub">WakeLock + reprise auto</span>
                                    </button>
                                    <button
                                        class="transcription-mode__btn"
                                        t-att-class="{'transcription-mode__btn--active': state.downloadMode === 'foreground'}"
                                        t-on-click="onSetDownloadModeForeground"
                                    >
                                        📲 Service de fond
                                        <span class="transcription-mode__sub">Recommandé ≥ 1 Go</span>
                                    </button>
                                </div>
                                <p t-if="state.downloadMode === 'foreground'" class="transcription-mode__hint">
                                    Service Android persistant avec notification + bouton Annuler. Survit même si l'écran reste éteint longtemps.
                                </p>
                                <p t-else="" class="transcription-mode__hint">
                                    Le CPU et le réseau restent actifs écran éteint. Reprend automatiquement où il s'était arrêté si interrompu.
                                </p>
                            </div>
                        </t>

                        <!-- ── Ready message ───────────────────────────────── -->
                        <div t-if="isCurrentModelDownloaded" class="transcription-ready">
                            <p>
                                ✓ Modèle prêt. Le bouton&amp;nbsp;<strong>T</strong>&amp;nbsp;
                                apparaîtra sur vos enregistrements pour les transcrire.
                            </p>
                            <p t-if="state.deleteError" class="transcription-error"
                               t-esc="state.deleteError" />
                        </div>

                        <!-- ── Download history ────────────────────────────── -->
                        <t t-if="state.recentDownloads.length > 0">
                            <div class="transcription-history">
                                <p class="transcription-section__title">Historique des téléchargements</p>
                                <t t-foreach="state.recentDownloads" t-as="dl" t-key="dl.id">
                                    <div class="transcription-history__item"
                                         t-att-class="{'transcription-history__item--expanded': state.expandedHistoryId === dl.id}"
                                         t-att-data-history-id="dl.id"
                                         t-on-click="onHistoryItemClick">
                                        <div class="transcription-history__row">
                                            <span class="transcription-history__name"
                                                  t-esc="dl.model || dl.label" />
                                            <span t-if="dl.downloadMode === 'foreground'"
                                                  class="transcription-history__mode"
                                                  title="Service de fond">📲</span>
                                            <span t-elif="dl.downloadMode"
                                                  class="transcription-history__mode"
                                                  title="WakeLock + reprise">🔋</span>
                                            <span
                                                class="transcription-history__status"
                                                t-att-class="{
                                                    'transcription-history__status--done':    dl.status === 'done',
                                                    'transcription-history__status--error':   dl.status === 'error',
                                                    'transcription-history__status--running': dl.status === 'running',
                                                }"
                                            >
                                                <t t-if="dl.status === 'running'">
                                                    <t t-esc="dl.percent || 0"/>%
                                                </t>
                                                <t t-elif="dl.status === 'done'">✓</t>
                                                <t t-elif="dl.status === 'error'" t-esc="dl.errorMessage || '✗'" />
                                            </span>
                                        </div>
                                        <!-- Expanded detail -->
                                        <t t-if="state.expandedHistoryId === dl.id">
                                            <div class="transcription-history__detail">
                                                <!-- Live progress for running downloads -->
                                                <t t-if="dl.status === 'running' and state.downloadingModels[dl.model]">
                                                    <div class="transcription-progress transcription-progress--sm">
                                                        <div class="transcription-progress__bar"
                                                             t-att-style="'width:' + (state.downloadingModels[dl.model].percent || 0) + '%'" />
                                                    </div>
                                                    <div class="transcription-history__bytes">
                                                        <span t-esc="formatBytes(state.downloadingModels[dl.model].receivedBytes)"/>
                                                        /
                                                        <span t-esc="formatBytes(state.downloadingModels[dl.model].totalBytes)"/>
                                                        <t t-if="state.downloadingModels[dl.model].speedBytesPerSec > 0">
                                                            · <span t-esc="formatSpeed(state.downloadingModels[dl.model].speedBytesPerSec)"/>
                                                        </t>
                                                    </div>
                                                </t>
                                                <!-- Static info for completed/failed -->
                                                <t t-if="dl.status !== 'running'">
                                                    <span class="transcription-history__detail-status">
                                                        <t t-if="dl.status === 'done'">Téléchargement terminé</t>
                                                        <t t-elif="dl.status === 'error'" t-esc="dl.errorMessage || 'Erreur inconnue'" />
                                                    </span>
                                                </t>
                                                <span class="transcription-history__detail-mode">
                                                    Mode : <t t-esc="dl.downloadMode === 'foreground' ? 'Service de fond' : 'Standard'"/>
                                                </span>
                                            </div>
                                        </t>
                                    </div>
                                </t>
                            </div>
                        </t>

                    </t>
                </t>
            </div>
        </div>
    `;

    static components = { HeadingComponent };

    models: ModelDef[] = ALL_MODELS;

    setup() {
        this.state = useState({
            enabled:          false,
            selectedModel:    "tiny" as WhisperModel,
            downloadedModels: {
                tiny:              false,
                base:              false,
                small:             false,
                medium:            false,
                "large-v3-turbo":  false,
                "distil-large-v3": false,
            } as Record<WhisperModel, boolean>,
            downloadingModels: {} as Partial<Record<WhisperModel, DownloadProgress>>,
            downloadMode:     "wakelock" as "wakelock" | "foreground",
            isDeleting:       false,
            deleteError:      "",
            recentDownloads:  [] as ProcessRecord[],
            expandedHistoryId: null as string | null,
            groqEnabled:      false,
            groqApiKey:       "",
        });

        let unsubscribeProgress:  (() => void) | null = null;
        let unsubscribeProcesses: (() => void) | null = null;

        const refreshDownloadHistory = () => {
            this.state.recentDownloads = this.processService
                .getAll()
                .filter(p => p.type === "download")
                .slice(0, 8);
        };

        onMounted(async () => {
            // Set up subscriptions FIRST so that maybeReconnectForeground()
            // (which calls downloadModel() fire-and-forget) triggers the
            // callback synchronously before loadSettings() runs.
            unsubscribeProgress = this.transcriptionService.subscribeProgress(async (info, model) => {
                if (info && model) {
                    this.state.downloadingModels = { ...this.state.downloadingModels, [model]: info };
                } else if (!info && model) {
                    const next = { ...this.state.downloadingModels };
                    delete next[model];
                    this.state.downloadingModels = next;
                    await this.refreshModelStatus();
                }
            });

            unsubscribeProcesses = this.processService.subscribe(() => {
                refreshDownloadHistory();
            });

            // Sync download state — either from in-memory tracking or by
            // re-attaching to a foreground service whose JS state was lost
            // (e.g. after Activity recreation while service kept running).
            const downloads = this.transcriptionService.activeDownloads;
            if (downloads.size > 0) {
                const newMap: Partial<Record<WhisperModel, DownloadProgress>> = {};
                downloads.forEach((progress, m) => { newMap[m] = progress; });
                this.state.downloadingModels = newMap;
            } else {
                await this.transcriptionService.maybeReconnectForeground();
            }

            await this.loadSettings();
            refreshDownloadHistory();
        });

        onWillDestroy(() => {
            if (unsubscribeProgress)  unsubscribeProgress();
            if (unsubscribeProcesses) unsubscribeProcesses();
        });
    }

    get isNative(): boolean {
        return Capacitor.isNativePlatform();
    }

    get isCurrentModelDownloaded(): boolean {
        return this.state.downloadedModels[this.state.selectedModel] ?? false;
    }

    get hasUndownloadedModels(): boolean {
        return ALL_MODELS.some(m => !this.state.downloadedModels[m.key]);
    }

    formatBytes(n: number): string {
        if (n <= 0) return "";
        if (n < 1_048_576) return (n / 1_024).toFixed(0) + " Ko";
        if (n < 1_073_741_824) return (n / 1_048_576).toFixed(1) + " Mo";
        return (n / 1_073_741_824).toFixed(2) + " Go";
    }

    formatSpeed(n: number): string { return this.formatBytes(n) + "/s"; }

    speedDots(m: ModelDef): string {
        return dots(m.speedDots, 5, "⚡", "·");
    }

    qualityDots(m: ModelDef): string {
        return dots(m.qualityDots, 5, "★", "☆");
    }

    private async loadSettings() {
        this.state.enabled       = await this.transcriptionService.isEnabled();
        this.state.selectedModel = await this.transcriptionService.getSelectedModel();
        this.state.downloadMode  = await this.transcriptionService.getDownloadMode();
        this.state.groqEnabled   = await this.transcriptionService.isGroqEnabled();
        this.state.groqApiKey    = await this.transcriptionService.getGroqApiKey();
        await this.refreshModelStatus();
    }

    async onToggleGroq() {
        this.state.groqEnabled = !this.state.groqEnabled;
        await this.transcriptionService.setGroqEnabled(this.state.groqEnabled);
    }

    async onGroqKeyChange(ev: Event) {
        const v = (ev.target as HTMLInputElement).value.trim();
        if (v === this.state.groqApiKey) return;
        this.state.groqApiKey = v;
        await this.transcriptionService.setGroqApiKey(v);
    }

    private async refreshModelStatus() {
        for (const m of ALL_MODELS) {
            this.state.downloadedModels[m.key] =
                await this.transcriptionService.isModelDownloaded(m.key);
        }
    }

    async onToggleEnabled() {
        this.state.enabled = !this.state.enabled;
        await this.transcriptionService.setEnabled(this.state.enabled);
    }

    onModelCardClick(event: MouseEvent) {
        const key = (event.currentTarget as HTMLElement).dataset.modelKey as WhisperModel;
        if (key) this.selectModel(key);
    }

    async selectModel(model: WhisperModel) {
        this.state.selectedModel = model;
        await this.transcriptionService.setSelectedModel(model);
    }

    onModelDownloadClick(event: MouseEvent) {
        event.stopPropagation();
        const key = (event.currentTarget as HTMLElement).dataset.modelKey as WhisperModel;
        if (key) this.startDownload(key);
    }

    async startDownload(model: WhisperModel) {
        try {
            await this.transcriptionService.downloadModel(model, this.state.downloadMode);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!msg.toLowerCase().includes("cancelled")) {
                console.warn("[Transcription] Download error:", msg);
            }
        }
    }

    onModelCancelClick(event: MouseEvent) {
        event.stopPropagation();
        const key = (event.currentTarget as HTMLElement).dataset.modelKey as WhisperModel;
        if (key) this.transcriptionService.cancelDownload(key);
    }

    onModelDeleteClick(event: MouseEvent) {
        event.stopPropagation();
        const key = (event.currentTarget as HTMLElement).dataset.modelKey as WhisperModel;
        if (key) this.deleteModel(key);
    }

    async deleteModel(model: WhisperModel) {
        this.state.isDeleting  = true;
        this.state.deleteError = "";
        try {
            await this.transcriptionService.deleteModel(model);
            await this.refreshModelStatus();
        } catch (e: unknown) {
            this.state.deleteError =
                "Erreur : " + (e instanceof Error ? e.message : String(e));
        } finally {
            this.state.isDeleting = false;
        }
    }

    onHistoryItemClick(event: MouseEvent) {
        const id = (event.currentTarget as HTMLElement).dataset.historyId as string;
        this.state.expandedHistoryId = this.state.expandedHistoryId === id ? null : id;
    }

    onSetDownloadModeWakelock()  { this.setDownloadMode("wakelock"); }
    onSetDownloadModeForeground() { this.setDownloadMode("foreground"); }

    async setDownloadMode(mode: "wakelock" | "foreground") {
        this.state.downloadMode = mode;
        await this.transcriptionService.setDownloadMode(mode);
    }
}
