import { onMounted, onWillDestroy, useState, xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { HeadingComponent } from "../../heading/heading_component";
import type { ProcessRecord } from "../../../models/process";

export class OptionsProcessesComponent extends EnhancedComponent {
    static template = xml`
        <div id="options-processes-component">
            <HeadingComponent title="'Options › Processus'" backUrl="'/options'" />

            <div class="processes-body">

                <t t-if="state.records.length === 0">
                    <p class="processes-empty">
                        Aucun processus pour cette session.
                    </p>
                </t>

                <t t-foreach="state.records" t-as="rec" t-key="rec.id">
                    <div
                        class="process-item"
                        t-att-class="{
                            'process-item--running': rec.status === 'running',
                            'process-item--done':    rec.status === 'done',
                            'process-item--error':   rec.status === 'error',
                        }"
                        t-att-data-record-id="rec.id"
                        t-on-click="onItemClick"
                    >
                        <div class="process-item__icon">
                            <t t-if="rec.type === 'transcription'">🎙️</t>
                            <t t-else="">⬇</t>
                        </div>

                        <div class="process-item__body">
                            <span class="process-item__label" t-esc="formatLabel(rec)" />
                            <span class="process-item__status">
                                <t t-if="rec.status === 'running'">
                                    <span class="process-spinner" />
                                    <t t-if="rec.percent and rec.percent > 0">
                                        <t t-esc="rec.percent"/>%
                                    </t>
                                    <t t-else="">En cours…</t>
                                </t>
                                <t t-elif="rec.status === 'done'">
                                    ✓ <t t-esc="formatDate(rec.completedAt)" />
                                    <span class="process-item__duration" t-esc="formatDuration(rec)" />
                                </t>
                                <t t-else="">
                                    ✗ <t t-esc="rec.errorMessage || 'Erreur'" />
                                    <span class="process-item__duration" t-esc="formatDuration(rec)" />
                                </t>
                            </span>
                        </div>

                        <button
                            t-if="canNavigate(rec)"
                            class="process-item__nav-btn"
                            t-att-data-record-id="rec.id"
                            t-on-click.stop="onNavClick"
                        >
                            ›
                        </button>
                    </div>
                </t>

                <t t-if="state.records.length > 0">
                    <button class="processes-clear-btn" t-on-click="onClearClick">
                        🗑 Nettoyer l'historique
                    </button>
                </t>
            </div>

            <!-- ── Detail modal ── -->
            <div t-if="state.detail" class="process-modal-backdrop" t-on-click="closeDetail">
                <div class="process-modal" t-on-click.stop="">
                    <div class="process-modal__header">
                        <span class="process-modal__icon">
                            <t t-if="state.detail.type === 'transcription'">🎙️</t>
                            <t t-else="">⬇</t>
                        </span>
                        <span class="process-modal__title" t-esc="formatLabel(state.detail)" />
                    </div>

                    <div class="process-modal__rows">
                        <div class="process-modal__row">
                            <span class="process-modal__key">Statut</span>
                            <span class="process-modal__val" t-esc="formatStatus(state.detail)" />
                        </div>
                        <div class="process-modal__row">
                            <span class="process-modal__key">Démarré</span>
                            <span class="process-modal__val" t-esc="formatDateTime(state.detail.startedAt)" />
                        </div>
                        <t t-if="state.detail.completedAt">
                            <div class="process-modal__row">
                                <span class="process-modal__key">Terminé</span>
                                <span class="process-modal__val" t-esc="formatDateTime(state.detail.completedAt)" />
                            </div>
                            <div class="process-modal__row">
                                <span class="process-modal__key">Durée</span>
                                <span class="process-modal__val" t-esc="formatDuration(state.detail)" />
                            </div>
                        </t>
                        <t t-if="state.detail.errorMessage">
                            <div class="process-modal__row">
                                <span class="process-modal__key">Erreur</span>
                                <span class="process-modal__val process-modal__val--error"
                                      t-esc="state.detail.errorMessage" />
                            </div>
                        </t>
                        <t t-if="state.detail.debugLog and state.detail.debugLog.length > 0">
                            <div class="process-modal__row process-modal__row--debug">
                                <span class="process-modal__key">Debug</span>
                                <pre class="process-modal__debug" t-esc="formatDebugLog(state.detail)" />
                            </div>
                        </t>
                        <t t-if="state.detail.result">
                            <div class="process-modal__row process-modal__row--result">
                                <span class="process-modal__key">
                                    <t t-if="state.detail.type === 'transcription'">Texte transcrit</t>
                                    <t t-else="">URL téléchargement</t>
                                </span>
                                <span class="process-modal__result" t-esc="state.detail.result" />
                            </div>
                        </t>
                    </div>

                    <button class="process-modal__close" t-on-click="closeDetail">Fermer</button>
                </div>
            </div>
        </div>
    `;

    static components = { HeadingComponent };

    setup() {
        this.state = useState({
            records: [] as ProcessRecord[],
            detail:  null as ProcessRecord | null,
        });

        let _unsub: (() => void) | null = null;

        const refresh = () => {
            this.state.records = this.processService.getAll();
        };

        onMounted(() => {
            refresh();
            _unsub = this.processService.subscribe(refresh);
        });

        onWillDestroy(() => { if (_unsub) _unsub(); });
    }

    // ── Row click → detail modal ──────────────────────────────────────────────

    onItemClick(event: MouseEvent): void {
        const id  = (event.currentTarget as HTMLElement).dataset.recordId;
        const rec = this.state.records.find(r => r.id === id);
        if (rec) this.state.detail = rec;
    }

    closeDetail(): void {
        this.state.detail = null;
    }

    // ── Navigate button ───────────────────────────────────────────────────────

    onNavClick(event: MouseEvent): void {
        const id  = (event.currentTarget as HTMLElement).dataset.recordId;
        const rec = this.state.records.find(r => r.id === id);
        if (!rec) return;

        if (rec.type === "transcription" && rec.noteId) {
            this.navigate(`/note/${rec.noteId}`);
        } else if (rec.type === "download") {
            this.navigate("/options/transcription");
        }
    }

    canNavigate(rec: ProcessRecord): boolean {
        if (rec.type === "transcription") return !!rec.noteId;
        return true;
    }

    // ── Nettoyer ──────────────────────────────────────────────────────────────

    async onClearClick(): Promise<void> {
        const { value } = await Dialog.confirm({
            title:         "Nettoyer l'historique",
            message:       "Supprimer tous les processus de l'historique ?",
            okButtonTitle: "Nettoyer",
            cancelButtonTitle: "Annuler",
        });
        if (!value) return;
        this.state.detail = null;
        await this.processService.clearAll();
    }

    // ── Formatting helpers ────────────────────────────────────────────────────

    formatLabel(rec: ProcessRecord): string {
        if (rec.type === "download") {
            return `Téléchargement modèle ${rec.model ?? rec.label}`;
        }
        return `Transcription ${rec.label}`;
    }

    formatStatus(rec: ProcessRecord): string {
        if (rec.status === "running") return "En cours";
        if (rec.status === "done")    return "Terminé";
        return "Erreur";
    }

    formatDate(date: Date | null): string {
        if (!date) return "";
        return date.toLocaleTimeString("fr-FR", {
            hour: "2-digit", minute: "2-digit", second: "2-digit",
        });
    }

    formatDateTime(date: Date | null): string {
        if (!date) return "";
        return date.toLocaleString("fr-FR", {
            day: "2-digit", month: "2-digit", year: "numeric",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
        });
    }

    formatDuration(rec: ProcessRecord): string {
        const end = rec.completedAt ?? new Date();
        const ms  = end.getTime() - rec.startedAt.getTime();
        if (ms < 1000) return `(${ms} ms)`;
        return `(${(ms / 1000).toFixed(1)} s)`;
    }

    formatDebugLog(rec: ProcessRecord): string {
        return (rec.debugLog ?? []).join("\n");
    }
}
