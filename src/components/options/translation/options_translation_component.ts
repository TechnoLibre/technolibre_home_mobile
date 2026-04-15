import { onMounted, onWillDestroy, useState, xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { HeadingComponent } from "../../heading/heading_component";
import type { TranslationApiType } from "../../../services/translationService";
import type { MarianDirection } from "../../../plugins/marianPlugin";

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

                        <!-- FR→EN model -->
                        <div class="tr-model">
                            <div class="tr-model__head">
                                <span class="tr-model__name"
                                      t-esc="t('label.marian_model_fr_en')"/>
                                <span t-att-class="'tr-status tr-status--' + marianStatusClass('fr-en')"
                                      t-esc="marianStatusLabel('fr-en')"/>
                            </div>
                            <div t-if="state.marianFrEnDownloading" class="tr-model__progress">
                                <progress class="tr-bar"
                                          t-att-value="state.marianFrEnPercent"
                                          max="100"/>
                                <span class="tr-pct"
                                      t-esc="state.marianFrEnPercent + '%'"/>
                                <button class="tr-btn tr-btn--danger"
                                        t-on-click="cancelMarianDownload"
                                        t-esc="t('button.cancel')"/>
                            </div>
                            <div t-elif="!state.marianFrEnReady" class="tr-model__actions">
                                <button class="tr-btn tr-btn--primary"
                                        t-on-click="() => this.downloadMarian('fr-en')">
                                    <t t-esc="t('button.download')"/>
                                    <span class="tr-btn__sub"
                                          t-esc="' (' + t('label.marian_model_size') + ')'"/>
                                </button>
                            </div>
                            <div t-else="" class="tr-model__actions">
                                <button class="tr-btn tr-btn--ghost"
                                        t-on-click="() => this.deleteMarian('fr-en')"
                                        t-esc="t('button.delete_model')"/>
                            </div>
                        </div>

                        <!-- EN→FR model -->
                        <div class="tr-model">
                            <div class="tr-model__head">
                                <span class="tr-model__name"
                                      t-esc="t('label.marian_model_en_fr')"/>
                                <span t-att-class="'tr-status tr-status--' + marianStatusClass('en-fr')"
                                      t-esc="marianStatusLabel('en-fr')"/>
                            </div>
                            <div t-if="state.marianEnFrDownloading" class="tr-model__progress">
                                <progress class="tr-bar"
                                          t-att-value="state.marianEnFrPercent"
                                          max="100"/>
                                <span class="tr-pct"
                                      t-esc="state.marianEnFrPercent + '%'"/>
                                <button class="tr-btn tr-btn--danger"
                                        t-on-click="cancelMarianDownload"
                                        t-esc="t('button.cancel')"/>
                            </div>
                            <div t-elif="!state.marianEnFrReady" class="tr-model__actions">
                                <button class="tr-btn tr-btn--primary"
                                        t-on-click="() => this.downloadMarian('en-fr')">
                                    <t t-esc="t('button.download')"/>
                                    <span class="tr-btn__sub"
                                          t-esc="' (' + t('label.marian_model_size') + ')'"/>
                                </button>
                            </div>
                            <div t-else="" class="tr-model__actions">
                                <button class="tr-btn tr-btn--ghost"
                                        t-on-click="() => this.deleteMarian('en-fr')"
                                        t-esc="t('button.delete_model')"/>
                            </div>
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
                        <t t-else="">🧪 Test — "Bonjour le monde"</t>
                    </button>
                    <p t-if="state.testResult"
                       t-att-class="'tr-test__result'
                           + (state.testError ? ' tr-test__result--error' : '')"
                       t-esc="state.testResult"/>
                </div>

            </div>
        </div>
    `;

    static components = { HeadingComponent };

    setup() {
        this.state = useState({
            apiType:     "ollama" as TranslationApiType,
            ollamaUrl:   "",
            ollamaModel: "",
            libreUrl:    "",
            isTesting:   false,
            testResult:  "",
            testError:   false,
            marianFrEnReady:       false,
            marianFrEnDownloading: false,
            marianFrEnPercent:     0,
            marianEnFrReady:       false,
            marianEnFrDownloading: false,
            marianEnFrPercent:     0,
        });

        let unsubMarian: (() => void) | null = null;

        onMounted(async () => {
            this.state.apiType     = await this.translationService.getApiType();
            this.state.ollamaUrl   = await this.translationService.getOllamaUrl();
            this.state.ollamaModel = await this.translationService.getOllamaModel();
            this.state.libreUrl    = await this.translationService.getLibreTranslateUrl();

            // Reconnect UI to any in-progress downloads
            this.marianService.activeDownloads.forEach((dl) => {
                this._applyMarianProgress(dl.direction, dl.percent, true);
            });

            // Check which models are already downloaded
            await Promise.all([
                this.marianService.isModelDownloaded("fr-en").then(ok => {
                    this.state.marianFrEnReady = ok;
                }),
                this.marianService.isModelDownloaded("en-fr").then(ok => {
                    this.state.marianEnFrReady = ok;
                }),
            ]);

            unsubMarian = this.marianService.subscribeProgress((dl, direction) => {
                if (!direction) return;
                if (dl === null) {
                    // Download finished (success or cancel) — refresh status
                    this.marianService.isModelDownloaded(direction).then(ok => {
                        this._applyMarianProgress(direction, 0, false);
                        if (direction === "fr-en") this.state.marianFrEnReady = ok;
                        else                       this.state.marianEnFrReady = ok;
                    });
                } else {
                    this._applyMarianProgress(direction, dl.percent, true);
                }
            });
        });

        onWillDestroy(() => {
            if (unsubMarian) unsubMarian();
        });
    }

    // ── MarianMT helpers ──────────────────────────────────────────────────────

    private _applyMarianProgress(
        dir: MarianDirection, percent: number, downloading: boolean
    ) {
        if (dir === "fr-en") {
            this.state.marianFrEnDownloading = downloading;
            this.state.marianFrEnPercent     = percent;
        } else {
            this.state.marianEnFrDownloading = downloading;
            this.state.marianEnFrPercent     = percent;
        }
    }

    marianStatusClass(dir: MarianDirection): string {
        const dl    = dir === "fr-en" ? this.state.marianFrEnDownloading : this.state.marianEnFrDownloading;
        const ready = dir === "fr-en" ? this.state.marianFrEnReady       : this.state.marianEnFrReady;
        if (dl)    return "downloading";
        if (ready) return "ready";
        return "missing";
    }

    marianStatusLabel(dir: MarianDirection): string {
        const dl    = dir === "fr-en" ? this.state.marianFrEnDownloading : this.state.marianEnFrDownloading;
        const ready = dir === "fr-en" ? this.state.marianFrEnReady       : this.state.marianEnFrReady;
        if (dl)    return this.t("label.marian_status_downloading");
        if (ready) return this.t("label.marian_status_ready");
        return this.t("label.marian_status_not_downloaded");
    }

    async downloadMarian(dir: MarianDirection) {
        this._applyMarianProgress(dir, 0, true);
        try {
            await this.marianService.downloadModel(dir);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            this._applyMarianProgress(dir, 0, false);
            await Dialog.alert({ message: msg });
        }
    }

    async deleteMarian(dir: MarianDirection) {
        await this.marianService.deleteModel(dir);
        if (dir === "fr-en") this.state.marianFrEnReady = false;
        else                  this.state.marianEnFrReady = false;
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
        try {
            const result = await this.translationService.translate(
                "Bonjour le monde", "fr", "en"
            );
            this.state.testResult = `✓  "Bonjour le monde" → "${result}"`;
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            this.state.testResult = this.t("error.translation_failed", { error: msg });
            this.state.testError  = true;
        } finally {
            this.state.isTesting = false;
        }
    }
}
