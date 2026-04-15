import { onMounted, onWillDestroy, useState, xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { HeadingComponent } from "../../heading/heading_component";
import type { TranslationApiType } from "../../../services/translationService";
import { MARIAN_MODELS } from "../../../plugins/marianPlugin";
import type { MarianModel, MarianModelInfo } from "../../../plugins/marianPlugin";

type ModelUI = { ready: boolean; downloading: boolean; percent: number };

export class OptionsTranslationComponent extends EnhancedComponent {
    static template = xml`
        <div id="options-translation-component">
            <HeadingComponent title="t('heading.translation')" backUrl="'/options'" />

            <div class="tr-body">

                <!-- ══ Local — no internet ══════════════════════════════════ -->
                <div class="tr-group">
                    <p class="tr-group__label tr-group__label--local"
                       t-esc="t('label.translation_local_group')"/>

                    <!-- MarianMT -->
                    <label t-att-class="'tr-option'
                               + (state.apiType === 'marian' ? ' tr-option--selected' : '')
                               + (state.apiType === 'marian' ? ' tr-option--open' : '')">
                        <input type="radio" name="api_type" value="marian"
                               t-att-checked="state.apiType === 'marian'"
                               t-on-change="() => this.setApiType('marian')"/>
                        <div class="tr-option__row">
                            <span class="tr-option__name"
                                  t-esc="t('label.translation_api_marian')"/>
                            <span class="tr-badge tr-badge--ondevice"
                                  t-esc="t('label.translation_badge_ondevice')"/>
                        </div>
                    </label>

                    <!-- MarianMT expand -->
                    <div t-if="state.apiType === 'marian'" class="tr-expand">
                        <p class="tr-hint" t-esc="t('hint.translation_marian')"/>

                        <!-- FR → EN section -->
                        <div class="tr-section">
                            <p class="tr-section__title"
                               t-esc="t('label.marian_section_fr_en')"/>
                            <t t-foreach="frEnModels" t-as="info" t-key="info.model">
                                <div t-att-class="modelCardClass(info.model)"
                                     t-on-click="() => this.selectMarianModel(info.model)">
                                    <div class="tr-model__radio"/>

                                    <div class="tr-model__info">
                                        <div class="tr-model__header">
                                            <span class="tr-model__name"
                                                  t-esc="marianModelName(info.model)"/>
                                            <span t-if="info.recommended"
                                                  class="tr-model__badge tr-model__badge--recommended"
                                                  t-esc="'★ ' + t('label.marian_recommended')"/>
                                            <span class="tr-model__size" t-esc="info.size"/>
                                        </div>

                                        <div class="tr-model__metrics">
                                            <span class="tr-model__metric">
                                                <span class="tr-model__metric-label"
                                                      t-esc="t('label.marian_speed')"/>
                                                <span class="tr-model__metric-dots"
                                                      t-esc="marianSpeedDots(info)"/>
                                                <span class="tr-model__metric-text"
                                                      t-esc="marianSpeedLabel(info)"/>
                                            </span>
                                            <span class="tr-model__metric">
                                                <span class="tr-model__metric-label"
                                                      t-esc="t('label.marian_quality')"/>
                                                <span class="tr-model__metric-dots tr-model__metric-dots--quality"
                                                      t-esc="marianQualityDots(info)"/>
                                                <span class="tr-model__metric-text"
                                                      t-esc="marianQualityLabel(info)"/>
                                            </span>
                                        </div>

                                        <t t-if="state.models[info.model].ready">
                                            <div class="tr-model__footer">
                                                <span class="tr-model__badge tr-model__badge--ok"
                                                      t-esc="'✓ ' + t('label.downloaded')"/>
                                                <button class="tr-model__delete-btn"
                                                        t-on-click.stop="() => this.deleteMarian(info.model)"
                                                        title="Supprimer">🗑</button>
                                            </div>
                                        </t>
                                        <t t-elif="state.models[info.model].downloading">
                                            <div class="tr-model__footer tr-model__footer--downloading">
                                                <div class="tr-progress tr-progress--sm">
                                                    <div class="tr-progress__bar"
                                                         t-att-style="'width:' + state.models[info.model].percent + '%'"/>
                                                </div>
                                                <span class="tr-model__dl-info">
                                                    <t t-esc="state.models[info.model].percent"/>%
                                                </span>
                                                <button class="tr-model__cancel-btn"
                                                        t-on-click.stop="cancelMarianDownload">✕</button>
                                            </div>
                                        </t>
                                        <t t-else="">
                                            <div class="tr-model__footer">
                                                <span class="tr-model__badge tr-model__badge--pending"
                                                      t-esc="t('label.model_to_download')"/>
                                                <button class="tr-model__dl-btn"
                                                        t-on-click.stop="() => this.downloadMarian(info.model)"
                                                        t-esc="t('button.download')"/>
                                            </div>
                                        </t>
                                    </div>
                                </div>
                            </t>
                        </div>

                        <!-- EN → FR section -->
                        <div class="tr-section">
                            <p class="tr-section__title"
                               t-esc="t('label.marian_section_en_fr')"/>
                            <t t-foreach="enFrModels" t-as="info" t-key="info.model">
                                <div t-att-class="modelCardClass(info.model)"
                                     t-on-click="() => this.selectMarianModel(info.model)">
                                    <div class="tr-model__radio"/>

                                    <div class="tr-model__info">
                                        <div class="tr-model__header">
                                            <span class="tr-model__name"
                                                  t-esc="marianModelName(info.model)"/>
                                            <span t-if="info.recommended"
                                                  class="tr-model__badge tr-model__badge--recommended"
                                                  t-esc="'★ ' + t('label.marian_recommended')"/>
                                            <span class="tr-model__size" t-esc="info.size"/>
                                        </div>

                                        <div class="tr-model__metrics">
                                            <span class="tr-model__metric">
                                                <span class="tr-model__metric-label"
                                                      t-esc="t('label.marian_speed')"/>
                                                <span class="tr-model__metric-dots"
                                                      t-esc="marianSpeedDots(info)"/>
                                                <span class="tr-model__metric-text"
                                                      t-esc="marianSpeedLabel(info)"/>
                                            </span>
                                            <span class="tr-model__metric">
                                                <span class="tr-model__metric-label"
                                                      t-esc="t('label.marian_quality')"/>
                                                <span class="tr-model__metric-dots tr-model__metric-dots--quality"
                                                      t-esc="marianQualityDots(info)"/>
                                                <span class="tr-model__metric-text"
                                                      t-esc="marianQualityLabel(info)"/>
                                            </span>
                                        </div>

                                        <t t-if="state.models[info.model].ready">
                                            <div class="tr-model__footer">
                                                <span class="tr-model__badge tr-model__badge--ok"
                                                      t-esc="'✓ ' + t('label.downloaded')"/>
                                                <button class="tr-model__delete-btn"
                                                        t-on-click.stop="() => this.deleteMarian(info.model)"
                                                        title="Supprimer">🗑</button>
                                            </div>
                                        </t>
                                        <t t-elif="state.models[info.model].downloading">
                                            <div class="tr-model__footer tr-model__footer--downloading">
                                                <div class="tr-progress tr-progress--sm">
                                                    <div class="tr-progress__bar"
                                                         t-att-style="'width:' + state.models[info.model].percent + '%'"/>
                                                </div>
                                                <span class="tr-model__dl-info">
                                                    <t t-esc="state.models[info.model].percent"/>%
                                                </span>
                                                <button class="tr-model__cancel-btn"
                                                        t-on-click.stop="cancelMarianDownload">✕</button>
                                            </div>
                                        </t>
                                        <t t-else="">
                                            <div class="tr-model__footer">
                                                <span class="tr-model__badge tr-model__badge--pending"
                                                      t-esc="t('label.model_to_download')"/>
                                                <button class="tr-model__dl-btn"
                                                        t-on-click.stop="() => this.downloadMarian(info.model)"
                                                        t-esc="t('button.download')"/>
                                            </div>
                                        </t>
                                    </div>
                                </div>
                            </t>
                        </div>
                    </div>

                    <!-- Ollama -->
                    <label t-att-class="'tr-option'
                               + (state.apiType === 'ollama' ? ' tr-option--selected' : '')
                               + (state.apiType === 'ollama' ? ' tr-option--open' : '')">
                        <input type="radio" name="api_type" value="ollama"
                               t-att-checked="state.apiType === 'ollama'"
                               t-on-change="() => this.setApiType('ollama')"/>
                        <div class="tr-option__row">
                            <span class="tr-option__name"
                                  t-esc="t('label.translation_api_ollama')"/>
                            <span class="tr-badge tr-badge--local"
                                  t-esc="t('label.translation_badge_local')"/>
                        </div>
                    </label>

                    <!-- Ollama expand -->
                    <div t-if="state.apiType === 'ollama'" class="tr-expand">
                        <p class="tr-hint" t-esc="t('hint.translation_ollama')"/>
                        <div class="tr-field">
                            <label class="tr-field__label" for="ollama-url"
                                   t-esc="t('label.ollama_url')"/>
                            <input id="ollama-url" type="url" class="tr-field__input"
                                   t-model="state.ollamaUrl"
                                   placeholder="http://localhost:11434"/>
                        </div>
                        <div class="tr-field">
                            <label class="tr-field__label" for="ollama-model"
                                   t-esc="t('label.ollama_model')"/>
                            <input id="ollama-model" type="text" class="tr-field__input"
                                   t-model="state.ollamaModel"
                                   placeholder="llama3.2"/>
                        </div>
                        <button class="tr-btn tr-btn--primary"
                                t-on-click="saveOllamaConfig"
                                t-esc="t('button.save')"/>
                    </div>

                    <!-- LibreTranslate -->
                    <label t-att-class="'tr-option'
                               + (state.apiType === 'libretranslate' ? ' tr-option--selected' : '')
                               + (state.apiType === 'libretranslate' ? ' tr-option--open' : '')">
                        <input type="radio" name="api_type" value="libretranslate"
                               t-att-checked="state.apiType === 'libretranslate'"
                               t-on-change="() => this.setApiType('libretranslate')"/>
                        <div class="tr-option__row">
                            <span class="tr-option__name"
                                  t-esc="t('label.translation_api_libretranslate')"/>
                            <span class="tr-badge tr-badge--neutral"
                                  t-esc="t('label.translation_badge_server')"/>
                        </div>
                    </label>

                    <!-- LibreTranslate expand -->
                    <div t-if="state.apiType === 'libretranslate'" class="tr-expand">
                        <p class="tr-hint" t-esc="t('hint.translation_libretranslate')"/>
                        <div class="tr-field">
                            <label class="tr-field__label" for="libre-url"
                                   t-esc="t('label.libre_translate_url')"/>
                            <input id="libre-url" type="url" class="tr-field__input"
                                   t-model="state.libreUrl"
                                   placeholder="http://localhost:5000/translate"/>
                        </div>
                        <button class="tr-btn tr-btn--primary"
                                t-on-click="saveLibreUrl"
                                t-esc="t('button.save')"/>
                    </div>
                </div>

                <!-- ══ Cloud — internet required ════════════════════════════ -->
                <div class="tr-group">
                    <p class="tr-group__label tr-group__label--internet"
                       t-esc="t('label.translation_internet_group')"/>

                    <label t-att-class="'tr-option'
                               + (state.apiType === 'mymemory' ? ' tr-option--selected' : '')">
                        <input type="radio" name="api_type" value="mymemory"
                               t-att-checked="state.apiType === 'mymemory'"
                               t-on-change="() => this.setApiType('mymemory')"/>
                        <div class="tr-option__row">
                            <span class="tr-option__name"
                                  t-esc="t('label.translation_api_mymemory')"/>
                            <span class="tr-badge tr-badge--internet"
                                  t-esc="t('label.translation_badge_internet')"/>
                        </div>
                    </label>
                </div>

                <!-- ══ Test ══════════════════════════════════════════════════ -->
                <div class="tr-test">
                    <button class="tr-btn tr-btn--test"
                            t-att-disabled="state.isTesting"
                            t-on-click="runTest">
                        <t t-if="state.isTesting">…</t>
                        <t t-else="">🧪 Test (3 phrases)</t>
                    </button>
                    <pre t-if="state.testResult"
                         t-att-class="'tr-test__result'
                             + (state.testError ? ' tr-test__result--error' : '')"
                         t-esc="state.testResult"/>
                </div>

            </div>
        </div>
    `;

    static components = { HeadingComponent };

    setup() {
        // Build initial per-model UI state
        const initModels = {} as Record<MarianModel, ModelUI>;
        for (const { model } of MARIAN_MODELS) {
            initModels[model] = { ready: false, downloading: false, percent: 0 };
        }

        this.state = useState({
            apiType:     "ollama" as TranslationApiType,
            ollamaUrl:   "",
            ollamaModel: "",
            libreUrl:    "",
            isTesting:   false,
            testResult:  "",
            testError:   false,
            selectedFrEn: "fr-en-tiny" as MarianModel,
            selectedEnFr: "en-fr-tiny" as MarianModel,
            models: initModels,
        });

        let unsubMarian: (() => void) | null = null;

        onMounted(async () => {
            // Load backend settings
            this.state.apiType     = await this.translationService.getApiType();
            this.state.ollamaUrl   = await this.translationService.getOllamaUrl();
            this.state.ollamaModel = await this.translationService.getOllamaModel();
            this.state.libreUrl    = await this.translationService.getLibreTranslateUrl();

            // Load selected Marian model per direction
            const [frEn, enFr] = await Promise.all([
                this.translationService.getSelectedMarianModel("fr-en"),
                this.translationService.getSelectedMarianModel("en-fr"),
            ]);
            this.state.selectedFrEn = frEn;
            this.state.selectedEnFr = enFr;

            // Reconnect to any in-progress downloads
            this.marianService.activeDownloads.forEach((dl, model) => {
                this.state.models[model].downloading = true;
                this.state.models[model].percent     = dl.percent;
            });

            // Subscribe to progress updates
            unsubMarian = this.marianService.subscribeProgress(async (dl, model) => {
                if (!model) return;
                if (dl === null) {
                    // Download finished (success or cancel) — refresh status
                    const ready = await this.marianService.isModelDownloaded(model);
                    this.state.models[model].downloading = false;
                    this.state.models[model].percent     = 0;
                    this.state.models[model].ready       = ready;
                } else {
                    this.state.models[model].downloading = true;
                    this.state.models[model].percent     = dl.percent;
                }
            });

            // Check which models are already downloaded
            await Promise.all(
                MARIAN_MODELS.map(async ({ model }) => {
                    this.state.models[model].ready =
                        await this.marianService.isModelDownloaded(model);
                })
            );
        });

        onWillDestroy(() => {
            if (unsubMarian) unsubMarian();
        });
    }

    // ── Model metadata helpers ────────────────────────────────────────────────

    get frEnModels(): MarianModelInfo[] {
        return MARIAN_MODELS.filter(m => m.direction === "fr-en");
    }

    get enFrModels(): MarianModelInfo[] {
        return MARIAN_MODELS.filter(m => m.direction === "en-fr");
    }

    marianModelName(model: MarianModel): string {
        if (model.endsWith("-tiny"))  return this.t("label.marian_variant_tiny");
        if (model.endsWith("-base"))  return this.t("label.marian_variant_base");
        if (model.endsWith("-large")) return this.t("label.marian_variant_large");
        return model;
    }

    modelCardClass(model: MarianModel): string {
        const isFrEn   = model.startsWith("fr-en");
        const selected = isFrEn ? this.state.selectedFrEn : this.state.selectedEnFr;
        return "tr-model"
            + (model === selected ? " tr-model--active" : "");
    }

    marianStatusClass(model: MarianModel): string {
        const { downloading, ready } = this.state.models[model];
        if (downloading) return "downloading";
        if (ready)       return "ready";
        return "missing";
    }

    marianStatusLabel(model: MarianModel): string {
        const { downloading, ready } = this.state.models[model];
        if (downloading) return this.t("label.marian_status_downloading");
        if (ready)       return this.t("label.marian_status_ready");
        return this.t("label.marian_status_not_downloaded");
    }

    marianSpeedDots(info: MarianModelInfo): string {
        return "⚡".repeat(info.speed) + "·".repeat(5 - info.speed);
    }

    marianQualityDots(info: MarianModelInfo): string {
        return "★".repeat(info.quality) + "☆".repeat(5 - info.quality);
    }

    marianSpeedLabel(info: MarianModelInfo): string {
        const labels: Record<number, string> = {
            1: "Très lent", 2: "Lent", 3: "Moyen", 4: "Rapide", 5: "Très rapide",
        };
        return labels[info.speed] ?? "";
    }

    marianQualityLabel(info: MarianModelInfo): string {
        const labels: Record<number, string> = {
            1: "Faible", 2: "Passable", 3: "Correcte", 4: "Bonne", 5: "Excellente",
        };
        return labels[info.quality] ?? "";
    }

    // ── MarianMT actions ──────────────────────────────────────────────────────

    async selectMarianModel(model: MarianModel) {
        const isFrEn = model.startsWith("fr-en");
        if (isFrEn) this.state.selectedFrEn = model;
        else        this.state.selectedEnFr = model;
        await this.translationService.setSelectedMarianModel(model);
    }

    async downloadMarian(model: MarianModel) {
        this.state.models[model].downloading = true;
        this.state.models[model].percent     = 0;
        try {
            await this.marianService.downloadModel(model);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            this.state.models[model].downloading = false;
            await Dialog.alert({ message: msg });
        }
    }

    async deleteMarian(model: MarianModel) {
        await this.marianService.deleteModel(model);
        this.state.models[model].ready = false;
    }

    async cancelMarianDownload() {
        await this.marianService.cancelDownload();
    }

    // ── Other backends ────────────────────────────────────────────────────────

    async setApiType(type: TranslationApiType) {
        this.state.apiType = type;
        await this.translationService.setApiType(type);
    }

    async saveOllamaConfig() {
        await this.translationService.setOllamaUrl(this.state.ollamaUrl.trim());
        await this.translationService.setOllamaModel(this.state.ollamaModel.trim());
        await Dialog.alert({
            title:   this.t("dialog.title.success"),
            message: this.t("message.translation_config_saved"),
        });
    }

    async saveLibreUrl() {
        await this.translationService.setLibreTranslateUrl(this.state.libreUrl.trim());
        await Dialog.alert({
            title:   this.t("dialog.title.success"),
            message: this.t("message.translation_config_saved"),
        });
    }

    async runTest() {
        if (this.state.isTesting) return;
        this.state.isTesting  = true;
        this.state.testResult = "";
        this.state.testError  = false;

        const TEST_PHRASES: Array<[string, "fr" | "en", "fr" | "en"]> = [
            ["Bonjour le monde",          "fr", "en"],
            ["La réunion est annulée.",   "fr", "en"],
            ["Hello world",               "en", "fr"],
        ];

        try {
            const lines: string[] = [];
            for (const [phrase, src, tgt] of TEST_PHRASES) {
                const result = await this.translationService.translate(phrase, src, tgt);
                lines.push(`"${phrase}" → "${result}"`);
            }
            this.state.testResult = "✓  " + lines.join("\n    ");
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            this.state.testResult = this.t("error.translation_failed", { error: msg });
            this.state.testError  = true;
        } finally {
            this.state.isTesting = false;
        }
    }
}
