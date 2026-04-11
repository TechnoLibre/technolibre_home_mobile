import { onMounted, onWillDestroy, useState, xml } from "@odoo/owl";
import { Capacitor } from "@capacitor/core";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { HeadingComponent } from "../../heading/heading_component";
import type { WhisperModel } from "../../../plugins/whisperPlugin";
import { MODEL_LABELS } from "../../../services/transcriptionService";

interface ModelDef {
    key: WhisperModel;
    label: string;
    size: string;
    desc: string;
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
                                Convertit les enregistrements audio en texte (Whisper,
                                entièrement local — aucun serveur, aucun abonnement).
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

                        <!-- ── Model selector ──────────────────────────────── -->
                        <div class="transcription-section">
                            <p class="transcription-section__title">Modèle Whisper</p>
                            <p class="transcription-section__hint">
                                Sélectionnez un modèle, puis téléchargez-le pour activer la transcription.
                            </p>

                            <t t-foreach="models" t-as="m" t-key="m.key">
                                <div
                                    class="transcription-model"
                                    t-att-class="{ 'transcription-model--active': state.selectedModel === m.key }"
                                    t-att-data-model-key="m.key"
                                    t-on-click="onModelCardClick"
                                >
                                    <div class="transcription-model__radio" />
                                    <div class="transcription-model__info">
                                        <div class="transcription-model__header">
                                            <span class="transcription-model__name" t-esc="m.label" />
                                            <span class="transcription-model__size" t-esc="m.size" />
                                        </div>
                                        <span class="transcription-model__desc" t-esc="m.desc" />
                                        <t t-if="m.key === 'tiny' ? state.tinyDownloaded : state.smallDownloaded">
                                            <span class="transcription-model__badge transcription-model__badge--ok">
                                                ✓ Téléchargé
                                            </span>
                                        </t>
                                        <t t-else="">
                                            <span class="transcription-model__badge transcription-model__badge--pending">
                                                À télécharger
                                            </span>
                                        </t>
                                    </div>
                                </div>
                            </t>
                        </div>

                        <!-- ── Download button ─────────────────────────────── -->
                        <t t-if="!isCurrentModelDownloaded">
                            <div class="transcription-download">
                                <button
                                    class="transcription-download__btn"
                                    t-att-disabled="state.isDownloading"
                                    t-on-click="downloadModel"
                                >
                                    <t t-if="!state.isDownloading">⬇ Télécharger le modèle sélectionné</t>
                                    <t t-else="">Téléchargement… <t t-esc="state.downloadPercent"/>%</t>
                                </button>

                                <div t-if="state.isDownloading" class="transcription-progress">
                                    <div
                                        class="transcription-progress__bar"
                                        t-att-style="'width: ' + state.downloadPercent + '%'"
                                    />
                                </div>

                                <p t-if="state.downloadError"
                                   class="transcription-error"
                                   t-esc="state.downloadError" />
                            </div>
                        </t>

                        <!-- ── Ready ───────────────────────────────────────── -->
                        <div t-if="isCurrentModelDownloaded" class="transcription-ready">
                            <p>
                                ✓ Modèle prêt. Le bouton&amp;nbsp;<strong>T</strong>&amp;nbsp;
                                apparaîtra sur vos enregistrements audio pour les transcrire.
                            </p>
                            <button class="transcription-delete__btn"
                                    t-att-disabled="state.isDeleting"
                                    t-on-click="deleteModel">
                                <t t-if="!state.isDeleting">🗑 Supprimer le modèle</t>
                                <t t-else="">Suppression…</t>
                            </button>
                            <p t-if="state.deleteError" class="transcription-error"
                               t-esc="state.deleteError" />
                        </div>

                    </t>
                </t>
            </div>
        </div>
    `;

    static components = { HeadingComponent };

    models: ModelDef[] = [
        {
            key:   "tiny",
            label: MODEL_LABELS.tiny,
            size:  "~75 Mo",
            desc:  "Rapide — précision correcte pour du français clair",
        },
        {
            key:   "small",
            label: MODEL_LABELS.small,
            size:  "~244 Mo",
            desc:  "Plus lent — meilleure précision, accents et bruit de fond",
        },
    ];

    setup() {
        this.state = useState({
            enabled:         false,
            selectedModel:   "tiny" as WhisperModel,
            tinyDownloaded:  false,
            smallDownloaded: false,
            isDownloading:   false,
            downloadPercent: 0,
            downloadError:   "",
            isDeleting:      false,
            deleteError:     "",
        });
        let unsubscribe: (() => void) | null = null;

        onMounted(async () => {
            // Subscribe and sync download state BEFORE loadSettings() so that
            // isModelDownloaded() (called inside loadSettings) already sees
            // isDownloading=true and skips the partial file on disk.
            const active = this.transcriptionService.activeDownload;
            if (active) {
                this.state.isDownloading   = true;
                this.state.downloadPercent = active.percent;
            }

            unsubscribe = this.transcriptionService.subscribeProgress(async (info) => {
                if (info) {
                    this.state.isDownloading   = true;
                    this.state.downloadPercent = info.percent;
                } else {
                    this.state.isDownloading = false;
                    await this.refreshModelStatus();
                }
            });

            await this.loadSettings();
        });

        onWillDestroy(() => { if (unsubscribe) unsubscribe(); });
    }

    get isNative(): boolean {
        return Capacitor.isNativePlatform();
    }

    get isCurrentModelDownloaded(): boolean {
        return this.state.selectedModel === "tiny"
            ? this.state.tinyDownloaded
            : this.state.smallDownloaded;
    }

    private async loadSettings() {
        this.state.enabled       = await this.transcriptionService.isEnabled();
        this.state.selectedModel = await this.transcriptionService.getSelectedModel();
        await this.refreshModelStatus();
    }

    private async refreshModelStatus() {
        this.state.tinyDownloaded  = await this.transcriptionService.isModelDownloaded("tiny");
        this.state.smallDownloaded = await this.transcriptionService.isModelDownloaded("small");
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

    async deleteModel() {
        this.state.isDeleting  = true;
        this.state.deleteError = "";
        try {
            await this.transcriptionService.deleteModel(this.state.selectedModel);
            await this.refreshModelStatus();
        } catch (e: unknown) {
            this.state.deleteError =
                "Erreur : " + (e instanceof Error ? e.message : String(e));
        } finally {
            this.state.isDeleting = false;
        }
    }

    async downloadModel() {
        this.state.isDownloading   = true;
        this.state.downloadPercent = 0;
        this.state.downloadError   = "";

        try {
            // Progress updates arrive via the service subscription (see setup()).
            await this.transcriptionService.downloadModel(this.state.selectedModel);
        } catch (e: unknown) {
            this.state.downloadError =
                "Erreur : " + (e instanceof Error ? e.message : String(e));
            this.state.isDownloading = false;
        }
        // On success, isDownloading is reset and refreshModelStatus() is called
        // by the subscribeProgress callback (info === null on completion).
    }
}
