import { onMounted, useRef, useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { Events } from "../../../constants/events";
import { Tag } from "../../../models/tag";

interface TagManagerState {
    search: string;
    noteId: string | null;
    noteTags: string[];   // tag IDs currently on the note
    allTags: Tag[];
    newColor: string;
    newParentId: string;
    saving: boolean;
    editingTagId: string | null;
    editingColor: string;
    liveMsg: string;
}

export class TagManagerComponent extends EnhancedComponent {
    state!: TagManagerState;
    tagManagerPopover = useRef("tag-manager-popover");

    static template = xml`
        <div
            id="tag-manager__popover"
            popover=""
            role="dialog"
            aria-modal="true"
            aria-labelledby="tag-manager__title"
            t-ref="tag-manager-popover"
            t-on-click.stop.prevent="hidePopover"
        >
            <div id="tag-manager__wrapper" t-on-click.stop.prevent="">
                <div id="tag-manager">

                    <!-- Live region: announces tag add/remove actions -->
                    <div class="sr-only" aria-live="polite" aria-atomic="true" t-esc="state.liveMsg" />

                    <section id="tag-manager__heading">
                        <h2 id="tag-manager__title">Gestionnaire de tags</h2>
                    </section>

                    <!-- Applied tags -->
                    <section id="tag-manager__applied" t-if="getAppliedTags().length > 0" aria-label="Tags appliqués">
                        <p class="tag-manager__section-label" aria-hidden="true">Tags appliqués</p>
                        <div class="tag-manager__chips" role="list">
                            <button
                                t-foreach="getAppliedTags()"
                                t-as="tag"
                                t-key="tag.id"
                                class="tag-manager__chip tag-manager__chip--applied"
                                t-att-style="'background-color:' + tag.color + ';border-color:' + tag.color"
                                t-att-aria-label="'Retirer le tag : ' + tag.name"
                                t-on-click.stop.prevent="() => this.removeTag(tag.id)"
                            >
                                <span t-esc="tag.name" aria-hidden="true"/>
                                <span class="tag-manager__chip-x" aria-hidden="true">×</span>
                            </button>
                        </div>
                    </section>

                    <!-- Search input -->
                    <section id="tag-manager__top-controls">
                        <label for="tag-manager__search" class="sr-only">Rechercher ou créer un tag</label>
                        <input
                            id="tag-manager__search"
                            type="text"
                            placeholder="Rechercher ou créer un tag…"
                            t-model="state.search"
                            autocomplete="off"
                            autocorrect="off"
                            spellcheck="false"
                        />
                    </section>

                    <!-- Available (unapplied) tags -->
                    <section id="tag-manager__content" aria-label="Tags disponibles">
                        <div class="tag-manager__chips" role="list">
                            <span
                                t-foreach="getUnappliedTags()"
                                t-as="tag"
                                t-key="tag.id"
                                class="tag-manager__chip-group"
                                role="listitem"
                            >
                                <button
                                    class="tag-manager__chip tag-manager__chip--available"
                                    t-att-style="'color:' + tag.color + ';border-color:' + tag.color"
                                    t-att-aria-label="'Appliquer le tag : ' + getTagLabel(tag)"
                                    t-on-click.stop.prevent="() => this.applyTag(tag.id)"
                                >
                                    <span t-esc="getTagLabel(tag)" aria-hidden="true"/>
                                </button>
                                <button
                                    class="tag-manager__chip-edit-btn"
                                    t-att-style="'color:' + tag.color"
                                    t-att-aria-label="'Modifier la couleur de : ' + tag.name"
                                    t-on-click.stop.prevent="() => this.startEditTag(tag)"
                                >✎</button>
                            </span>
                        </div>
                        <p
                            t-if="getUnappliedTags().length === 0 and getAppliedTags().length === 0 and state.search === ''"
                            class="tag-manager__empty"
                        >
                            Aucun tag. Tapez un nom pour en créer un.
                        </p>
                    </section>

                    <!-- Edit tag color form -->
                    <section id="tag-manager__edit-form" t-if="state.editingTagId" aria-label="Modifier la couleur du tag">
                        <t t-set="editTag" t-value="getEditingTag()" />
                        <p class="tag-manager__section-label" id="tag-manager__edit-label">
                            Modifier « <t t-esc="editTag and editTag.name or ''" /> »
                        </p>
                        <div class="tag-manager__color-picker" role="group" aria-labelledby="tag-manager__edit-label">
                            <div class="tag-manager__color-swatches" role="radiogroup" aria-label="Couleurs préréglées">
                                <button
                                    t-foreach="getPresetColors()"
                                    t-as="c"
                                    t-key="c"
                                    type="button"
                                    class="tag-manager__color-swatch"
                                    t-att-style="'background-color:' + c"
                                    t-att-class="{ 'tag-manager__color-swatch--selected': state.editingColor === c }"
                                    t-att-aria-label="'Couleur ' + c"
                                    t-att-aria-pressed="state.editingColor === c ? 'true' : 'false'"
                                    t-on-click.stop.prevent="() => this.selectEditColor(c)"
                                />
                            </div>
                            <div class="tag-manager__color-hex-row">
                                <div class="tag-manager__color-preview" aria-hidden="true" t-att-style="'background-color:' + state.editingColor" />
                                <label for="tag-manager__edit-hex" class="sr-only">Code couleur hexadécimal</label>
                                <input
                                    id="tag-manager__edit-hex"
                                    type="text"
                                    class="tag-manager__color-hex-input"
                                    placeholder="#6b7280"
                                    aria-label="Code couleur hexadécimal"
                                    t-model="state.editingColor"
                                />
                            </div>
                        </div>
                        <div class="tag-manager__edit-controls">
                            <a
                                class="tag-manager__action"
                                href="#"
                                role="button"
                                t-on-click.stop.prevent="saveTagColor"
                            >Enregistrer</a>
                            <a
                                class="tag-manager__action tag-manager__action--close"
                                href="#"
                                role="button"
                                t-on-click.stop.prevent="cancelEditTag"
                            >Annuler</a>
                        </div>
                    </section>

                    <!-- Create form (name from search field, no exact match) -->
                    <section id="tag-manager__create-form" t-if="canCreate()" aria-label="Créer un tag">
                        <p class="tag-manager__section-label" id="tag-manager__create-label">
                            Créer « <t t-esc="state.search.trim()" /> »
                        </p>
                        <div class="tag-manager__create-row">
                            <label for="tag-manager__parent-select" class="sr-only">Tag parent</label>
                            <select id="tag-manager__parent-select" t-model="state.newParentId" class="tag-manager__parent-select">
                                <option value="">Aucun parent</option>
                                <t t-foreach="state.allTags" t-as="pt" t-key="pt.id">
                                    <option t-att-value="pt.id" t-esc="pt.name" />
                                </t>
                            </select>
                        </div>
                        <div class="tag-manager__color-picker" role="group" aria-labelledby="tag-manager__create-label">
                            <div class="tag-manager__color-swatches" role="radiogroup" aria-label="Couleurs préréglées">
                                <button
                                    t-foreach="getPresetColors()"
                                    t-as="c"
                                    t-key="c"
                                    type="button"
                                    class="tag-manager__color-swatch"
                                    t-att-style="'background-color:' + c"
                                    t-att-class="{ 'tag-manager__color-swatch--selected': state.newColor === c }"
                                    t-att-aria-label="'Couleur ' + c"
                                    t-att-aria-pressed="state.newColor === c ? 'true' : 'false'"
                                    t-on-click.stop.prevent="() => this.selectColor(c)"
                                />
                            </div>
                            <div class="tag-manager__color-hex-row">
                                <div class="tag-manager__color-preview" aria-hidden="true" t-att-style="'background-color:' + state.newColor" />
                                <label for="tag-manager__new-hex" class="sr-only">Code couleur hexadécimal</label>
                                <input
                                    id="tag-manager__new-hex"
                                    type="text"
                                    class="tag-manager__color-hex-input"
                                    placeholder="#6b7280"
                                    aria-label="Code couleur hexadécimal"
                                    t-model="state.newColor"
                                />
                            </div>
                        </div>
                    </section>

                    <!-- Bottom controls -->
                    <section id="tag-manager__bottom-controls">
                        <a
                            t-if="canCreate()"
                            id="tag-manager__create"
                            class="tag-manager__action"
                            href="#"
                            role="button"
                            t-att-aria-disabled="state.saving ? 'true' : 'false'"
                            t-att-class="{ 'disabled': state.saving }"
                            t-on-click.stop.prevent="onCreateTagClick"
                        >
                            Créer
                        </a>
                        <a
                            id="tag-manager__close"
                            class="tag-manager__action tag-manager__action--close"
                            href="#"
                            role="button"
                            aria-label="Fermer le gestionnaire de tags"
                            t-on-click.stop.prevent="hidePopover"
                        >
                            Fermer
                        </a>
                    </section>

                </div>
            </div>
        </div>
    `;

    setup() {
        this.state = useState<TagManagerState>({
            search: "",
            noteId: null,
            noteTags: [],
            allTags: [],
            newColor: "#6b7280",
            newParentId: "",
            saving: false,
            editingTagId: null,
            editingColor: "#6b7280",
            liveMsg: "",
        });
        onMounted(() => {
            this.eventBus.addEventListener(Events.TAG_MANAGER, this.onTagManagerEvent.bind(this));
        });
    }

    async onTagManagerEvent(event: any) {
        const noteId: string | null = event?.detail?.noteId ?? null;
        this.state.noteId = noteId;
        this.state.search = "";
        this.state.newColor = "#6b7280";
        this.state.newParentId = "";
        this.state.saving = false;
        this.state.editingTagId = null;
        this.state.editingColor = "#6b7280";

        const allTags = await this.tagService.getAllTags();
        this.state.allTags = allTags;

        if (noteId) {
            try {
                const note = await this.noteService.getMatch(noteId);
                this.state.noteTags = [...note.tags];
            } catch {
                this.state.noteTags = [];
            }
        } else {
            this.state.noteTags = [];
        }

        this.showPopover();
    }

    showPopover() {
        this.tagManagerPopover.el?.showPopover();
    }

    hidePopover() {
        this.tagManagerPopover.el?.hidePopover();
        if (this.state.noteId) {
            this.eventBus.trigger(Events.NOTE_TAGS_UPDATED, {
                noteId: this.state.noteId,
                tagIds: [...this.state.noteTags],
            });
        }
    }

    // ── Derived data ────────────────────────────────────────

    getAppliedTags(): Tag[] {
        return this.state.allTags.filter((t) => this.state.noteTags.includes(t.id));
    }

    getUnappliedTags(): Tag[] {
        const search = this.state.search.trim().toLowerCase();
        return this.state.allTags.filter((t) => {
            if (this.state.noteTags.includes(t.id)) return false;
            if (search && !t.name.toLowerCase().includes(search)) return false;
            return true;
        });
    }

    /** Show parent path prefix for clarity, e.g. "Projet › Dev" */
    getTagLabel(tag: Tag): string {
        if (!tag.parentId) return tag.name;
        const parent = this.state.allTags.find((t) => t.id === tag.parentId);
        return parent ? `${parent.name} › ${tag.name}` : tag.name;
    }

    getEditingTag(): Tag | undefined {
        return this.state.allTags.find((t) => t.id === this.state.editingTagId);
    }

    startEditTag(tag: Tag) {
        this.state.editingTagId = tag.id;
        this.state.editingColor = tag.color;
    }

    cancelEditTag() {
        this.state.editingTagId = null;
    }

    async saveTagColor() {
        if (!this.state.editingTagId) return;
        const tag = this.getEditingTag();
        if (!tag) return;
        await this.tagService.updateTag(this.state.editingTagId, {
            ...tag,
            color: this.state.editingColor,
        });
        this.state.allTags = await this.tagService.getAllTags();
        this.state.editingTagId = null;
        this.eventBus.trigger(Events.TAGS_UPDATED, {});
    }

    selectEditColor(color: string) {
        this.state.editingColor = color;
    }

    getPresetColors(): string[] {
        return [
            "#ef4444", "#f97316", "#eab308", "#84cc16", "#22c55e",
            "#10b981", "#14b8a6", "#06b6d4", "#0ea5e9", "#3b82f6",
            "#6366f1", "#8b5cf6", "#a855f7", "#d946ef", "#ec4899",
            "#f43f5e", "#78716c", "#6b7280", "#374151", "#1e293b",
        ];
    }

    selectColor(color: string) {
        this.state.newColor = color;
    }

    canCreate(): boolean {
        const name = this.state.search.trim().toLowerCase();
        if (!name) return false;
        return !this.state.allTags.some((t) => t.name.toLowerCase() === name);
    }

    // ── Actions ─────────────────────────────────────────────

    async applyTag(tagId: string) {
        if (this.state.noteTags.includes(tagId)) return;
        this.state.noteTags = [...this.state.noteTags, tagId];
        const tag = this.state.allTags.find((t) => t.id === tagId);
        this._announce(tag ? `Tag appliqué : ${tag.name}` : "Tag appliqué");
        await this.saveTagsToNote();
    }

    async removeTag(tagId: string) {
        const tag = this.state.allTags.find((t) => t.id === tagId);
        this.state.noteTags = this.state.noteTags.filter((id) => id !== tagId);
        this._announce(tag ? `Tag retiré : ${tag.name}` : "Tag retiré");
        await this.saveTagsToNote();
    }

    private _announce(msg: string) {
        this.state.liveMsg = "";
        // Defer so the DOM sees the empty → non-empty transition
        setTimeout(() => { this.state.liveMsg = msg; }, 50);
        setTimeout(() => { this.state.liveMsg = ""; }, 3000);
    }

    private async saveTagsToNote() {
        if (!this.state.noteId) return;
        try {
            const note = await this.noteService.getMatch(this.state.noteId);
            await this.noteService.crud.edit(this.state.noteId, {
                ...note,
                tags: [...this.state.noteTags],
            });
        } catch (e) {
            console.error("[TagManager] failed to save tags", e);
        }
    }

    async onCreateTagClick() {
        const name = this.state.search.trim();
        if (!name || this.state.saving) return;
        this.state.saving = true;
        try {
            const newTag: Tag = {
                id: this.tagService.getNewId(),
                name,
                color: this.state.newColor,
                parentId: this.state.newParentId || undefined,
            };
            await this.tagService.addTag(newTag);
            this.state.allTags = await this.tagService.getAllTags();
            // Automatically apply it to the current note
            this.state.noteTags = [...this.state.noteTags, newTag.id];
            await this.saveTagsToNote();
            this.state.search = "";
            this.state.newColor = "#6b7280";
            this.state.newParentId = "";
        } finally {
            this.state.saving = false;
        }
    }
}
