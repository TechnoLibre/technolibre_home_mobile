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

            <div class="translation-body">

                <!-- ══ Local — no internet ══════════════════════════════════ -->
                <section class="translation-section">
                    <p class="translation-section__group-label translation-section__group-label--local"
                       t-esc="t('label.translation_local_group')"/>

                    <!-- MarianMT (on-device) -->
                    <label class="translation-api-option">
                        <input
                            type="radio"
                            name="api_type"
                            value="marian"
                            t-att-checked="state.apiType === 'marian'"
                            t-on-change="() => this.setApiType('marian')"
                        />
                        <div class="translation-api-option__body">
                            <span class="translation-api-option__name"
                                  t-esc="t('label.translation_api_marian')"/>
                            <span class="translation-badge translation-badge--ondevice"
                                  t-esc="t('label.translation_badge_ondevice')"/>
                        </div>
                    </label>

                    <!-- MarianMT config (shown when selected) -->
                    <div t-if="state.apiType === 'marian'" class="translation-config-block">
                        <p class="translation-config-hint" t-esc="t('hint.translation_marian')"/>

                        <!-- FR→EN model -->
                        <div class="translation-marian-model">
                            <div class="translation-marian-model__header">
                                <span class="translation-config-label"
                                      t-esc="t('label.marian_model_fr_en')"/>
                                <span t-att-class="'translation-marian-status translation-marian-status--' + marianStatusClass('fr-en')"
                                      t-esc="marianStatusLabel('fr-en')"/>
                            </div>
                            <div class="translation-marian-model__actions">
                                <button
                                    t-if="!state.marianFrEnReady and !state.marianFrEnDownloading"
                                    class="translation-url-save"
                                    t-on-click="() => this.downloadMarian('fr-en')"
                                    t-esc="t('button.download') + ' (' + t('label.marian_model_size') + ')'"/>
                                <div t-if="state.marianFrEnDownloading" class="translation-marian-progress">
                                    <progress
                                        class="translation-marian-bar"
                                        t-att-value="state.marianFrEnPercent"
                                        max="100"/>
                                    <span class="translation-marian-percent"
                                          t-esc="state.marianFrEnPercent + '%'"/>
                                    <button
                                        class="translation-url-save translation-url-save--danger"
                                        t-on-click="cancelMarianDownload"
                                        t-esc="t('button.cancel')"/>
                                </div>
                                <button
                                    t-if="state.marianFrEnReady and !state.marianFrEnDownloading"
                                    class="translation-test-btn"
                                    t-on-click="() => this.deleteMarian('fr-en')"
                                    t-esc="t('button.delete_model')"/>
                            </div>
                        </div>

                        <!-- EN→FR model -->
                        <div class="translation-marian-model">
                            <div class="translation-marian-model__header">
                                <span class="translation-config-label"
                                      t-esc="t('label.marian_model_en_fr')"/>
                                <span t-att-class="'translation-marian-status translation-marian-status--' + marianStatusClass('en-fr')"
                                      t-esc="marianStatusLabel('en-fr')"/>
                            </div>
                            <div class="translation-marian-model__actions">
                                <button
                                    t-if="!state.marianEnFrReady and !state.marianEnFrDownloading"
                                    class="translation-url-save"
                                    t-on-click="() => this.downloadMarian('en-fr')"
                                    t-esc="t('button.download') + ' (' + t('label.marian_model_size') + ')'"/>
                                <div t-if="state.marianEnFrDownloading" class="translation-marian-progress">
                                    <progress
                                        class="translation-marian-bar"
                                        t-att-value="state.marianEnFrPercent"
                                        max="100"/>
                                    <span class="translation-marian-percent"
                                          t-esc="state.marianEnFrPercent + '%'"/>
                                    <button
                                        class="translation-url-save translation-url-save--danger"
                                        t-on-click="cancelMarianDownload"
                                        t-esc="t('button.cancel')"/>
                                </div>
                                <button
                                    t-if="state.marianEnFrReady and !state.marianEnFrDownloading"
                                    class="translation-test-btn"
                                    t-on-click="() => this.deleteMarian('en-fr')"
                                    t-esc="t('button.delete_model')"/>
                            </div>
                        </div>
                    </div>

                    <!-- Ollama -->
                    <label class="translation-api-option">
                        <input
                            type="radio"
                            name="api_type"
                            value="ollama"
                            t-att-checked="state.apiType === 'ollama'"
                            t-on-change="() => this.setApiType('ollama')"
                        />
                        <div class="translation-api-option__body">
                            <span class="translation-api-option__name"
                                  t-esc="t('label.translation_api_ollama')"/>
                            <span class="translation-badge translation-badge--local"
                                  t-esc="t('label.translation_badge_local')"/>
                        </div>
                    </label>

                    <!-- Ollama config (shown when selected) -->
                    <div t-if="state.apiType === 'ollama'" class="translation-config-block">
                        <p class="translation-config-hint" t-esc="t('hint.translation_ollama')"/>
                        <div class="translation-config-row">
                            <label class="translation-config-label" for="ollama-url"
                                   t-esc="t('label.ollama_url')"/>
                            <div class="translation-url-row">
                                <input
                                    id="ollama-url"
                                    type="url"
                                    class="translation-url-input"
                                    t-model="state.ollamaUrl"
                                    placeholder="http://localhost:11434"
                                />
                            </div>
                        </div>
                        <div class="translation-config-row">
                            <label class="translation-config-label" for="ollama-model"
                                   t-esc="t('label.ollama_model')"/>
                            <div class="translation-url-row">
                                <input
                                    id="ollama-model"
                                    type="text"
                                    class="translation-url-input"
                                    t-model="state.ollamaModel"
                                    placeholder="llama3.2"
                                />
                            </div>
                        </div>
                        <button class="translation-url-save"
                                t-on-click="saveOllamaConfig"
                                t-esc="t('button.save')"/>
                    </div>

                    <!-- LibreTranslate (local) -->
                    <label class="translation-api-option">
                        <input
                            type="radio"
                            name="api_type"
                            value="libretranslate"
                            t-att-checked="state.apiType === 'libretranslate'"
                            t-on-change="() => this.setApiType('libretranslate')"
                        />
                        <div class="translation-api-option__body">
                            <span class="translation-api-option__name"
                                  t-esc="t('label.translation_api_libretranslate')"/>
                            <span class="translation-badge translation-badge--neutral"
                                  t-esc="t('label.translation_badge_server')"/>
                        </div>
                    </label>

                    <!-- LibreTranslate config (shown when selected) -->
                    <div t-if="state.apiType === 'libretranslate'" class="translation-config-block">
                        <p class="translation-config-hint" t-esc="t('hint.translation_libretranslate')"/>
                        <div class="translation-config-row">
                            <label class="translation-config-label" for="libre-url"
                                   t-esc="t('label.libre_translate_url')"/>
                            <div class="translation-url-row">
                                <input
                                    id="libre-url"
                                    type="url"
                                    class="translation-url-input"
                                    t-model="state.libreUrl"
                                    placeholder="http://localhost:5000/translate"
                                />
                            </div>
                        </div>
                        <button class="translation-url-save"
                                t-on-click="saveLibreUrl"
                                t-esc="t('button.save')"/>
                    </div>
                </section>

                <!-- ══ Cloud — internet required ════════════════════════════════ -->
                <section class="translation-section">
                    <p class="translation-section__group-label translation-section__group-label--internet"
                       t-esc="t('label.translation_internet_group')"/>

                    <label class="translation-api-option">
                        <input
                            type="radio"
                            name="api_type"
                            value="mymemory"
                            t-att-checked="state.apiType === 'mymemory'"
                            t-on-change="() => this.setApiType('mymemory')"
                        />
                        <div class="translation-api-option__body">
                            <span class="translation-api-option__name"
                                  t-esc="t('label.translation_api_mymemory')"/>
                            <span class="translation-badge translation-badge--internet"
                                  t-esc="t('label.translation_badge_internet')"/>
                        </div>
                    </label>
                </section>

                <!-- ══ Test ══════════════════════════════════════════════════ -->
                <section class="translation-section">
                    <button
                        class="translation-test-btn"
                        t-att-disabled="state.isTesting"
                        t-on-click="runTest"
                    >
                        <t t-if="state.isTesting">…</t>
                        <t t-else="">🧪 Test — "Bonjour le monde"</t>
                    </button>
                    <p t-if="state.testResult"
                       t-att-class="'translation-test-result' + (state.testError ? ' translation-test-result--error' : '')"
                       t-esc="state.testResult"/>
                </section>

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
            // MarianMT per-direction status
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

            // Reconnect to any in-progress downloads
            this.marianService.activeDownloads.forEach((dl) => {
                this._applyMarianProgress(dl.direction, dl.percent, true);
            });

            // Check downloaded status
            [
                this.marianService.isModelDownloaded("fr-en").then(ok => { this.state.marianFrEnReady = ok; }),
                this.marianService.isModelDownloaded("en-fr").then(ok => { this.state.marianEnFrReady = ok; }),
            ];

            unsubMarian = this.marianService.subscribeProgress((dl, direction) => {
                if (!direction) return;
                if (dl === null) {
                    // Download finished (success or cancel) — re-check downloaded status
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

    private _applyMarianProgress(dir: MarianDirection, percent: number, downloading: boolean) {
        if (dir === "fr-en") {
            this.state.marianFrEnDownloading = downloading;
            this.state.marianFrEnPercent     = percent;
        } else {
            this.state.marianEnFrDownloading = downloading;
            this.state.marianEnFrPercent     = percent;
        }
    }

    marianStatusClass(dir: MarianDirection): string {
        const downloading = dir === "fr-en" ? this.state.marianFrEnDownloading : this.state.marianEnFrDownloading;
        const ready       = dir === "fr-en" ? this.state.marianFrEnReady       : this.state.marianEnFrReady;
        if (downloading) return "downloading";
        if (ready)       return "ready";
        return "missing";
    }

    marianStatusLabel(dir: MarianDirection): string {
        const downloading = dir === "fr-en" ? this.state.marianFrEnDownloading : this.state.marianEnFrDownloading;
        const ready       = dir === "fr-en" ? this.state.marianFrEnReady       : this.state.marianEnFrReady;
        if (downloading) return this.t("label.marian_status_downloading");
        if (ready)       return this.t("label.marian_status_ready");
        return this.t("label.marian_status_not_downloaded");
    }

    async downloadMarian(dir: MarianDirection) {
        this._applyMarianProgress(dir, 0, true);
        try {
            await this.marianService.downloadModel(dir);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
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

    // ── Existing backends ─────────────────────────────────────────────────────

    async setApiType(type: TranslationApiType) {
        this.state.apiType = type;
        await this.translationService.setApiType(type);
    }

    async saveOllamaConfig() {
        await this.translationService.setOllamaUrl(this.state.ollamaUrl.trim());
        await this.translationService.setOllamaModel(this.state.ollamaModel.trim());
        await Dialog.alert({
            title: this.t("dialog.title.success"),
            message: this.t("message.translation_config_saved"),
        });
    }

    async saveLibreUrl() {
        await this.translationService.setLibreTranslateUrl(this.state.libreUrl.trim());
        await Dialog.alert({
            title: this.t("dialog.title.success"),
            message: this.t("message.translation_config_saved"),
        });
    }

    async runTest() {
        if (this.state.isTesting) return;
        this.state.isTesting  = true;
        this.state.testResult = "";
        this.state.testError  = false;
        try {
            const result = await this.translationService.translate("Bonjour le monde", "fr", "en");
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
