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
}

export class TagManagerComponent extends EnhancedComponent {
    state!: TagManagerState;
    tagManagerPopover = useRef("tag-manager-popover");

    static template = xml`
        <div
            id="tag-manager__popover"
            popover=""
            t-ref="tag-manager-popover"
            t-on-click.stop.prevent="hidePopover"
        >
            <div id="tag-manager__wrapper" t-on-click.stop.prevent="">
                <div id="tag-manager">

                    <section id="tag-manager__heading">
                        <h3>Gestionnaire de tags</h3>
                    </section>

                    <!-- Applied tags -->
                    <section id="tag-manager__applied" t-if="getAppliedTags().length > 0">
                        <p class="tag-manager__section-label">Tags appliqués</p>
                        <div class="tag-manager__chips">
                            <button
                                t-foreach="getAppliedTags()"
                                t-as="tag"
                                t-key="tag.id"
                                class="tag-manager__chip tag-manager__chip--applied"
                                t-att-style="'background-color:' + tag.color + ';border-color:' + tag.color"
                                t-on-click.stop.prevent="() => this.removeTag(tag.id)"
                            >
                                <span t-esc="tag.name" />
                                <span class="tag-manager__chip-x">×</span>
                            </button>
                        </div>
                    </section>

                    <!-- Search input -->
                    <section id="tag-manager__top-controls">
                        <input
                            id="tag-manager__search"
                            type="text"
                            placeholder="Rechercher ou créer un tag…"
                            t-model="state.search"
                        />
                    </section>

                    <!-- Available (unapplied) tags -->
                    <section id="tag-manager__content">
                        <div class="tag-manager__chips">
                            <button
                                t-foreach="getUnappliedTags()"
                                t-as="tag"
                                t-key="tag.id"
                                class="tag-manager__chip tag-manager__chip--available"
                                t-att-style="'color:' + tag.color + ';border-color:' + tag.color"
                                t-on-click.stop.prevent="() => this.applyTag(tag.id)"
                            >
                                <span t-esc="getTagLabel(tag)" />
                            </button>
                        </div>
                        <p
                            t-if="getUnappliedTags().length === 0 and getAppliedTags().length === 0 and state.search === ''"
                            class="tag-manager__empty"
                        >
                            Aucun tag. Tapez un nom pour en créer un.
                        </p>
                    </section>

                    <!-- Create form (name from search field, no exact match) -->
                    <section id="tag-manager__create-form" t-if="canCreate()">
                        <p class="tag-manager__section-label">
                            Créer « <t t-esc="state.search.trim()" /> »
                        </p>
                        <div class="tag-manager__create-row">
                            <select t-model="state.newParentId" class="tag-manager__parent-select">
                                <option value="">Aucun parent</option>
                                <t t-foreach="state.allTags" t-as="pt" t-key="pt.id">
                                    <option t-att-value="pt.id" t-esc="pt.name" />
                                </t>
                            </select>
                        </div>
                        <div class="tag-manager__color-picker">
                            <div class="tag-manager__color-swatches">
                                <button
                                    t-foreach="getPresetColors()"
                                    t-as="c"
                                    t-key="c"
                                    type="button"
                                    class="tag-manager__color-swatch"
                                    t-att-style="'background-color:' + c"
                                    t-att-class="{ 'tag-manager__color-swatch--selected': state.newColor === c }"
                                    t-on-click.stop.prevent="() => this.selectColor(c)"
                                />
                            </div>
                            <div class="tag-manager__color-hex-row">
                                <div class="tag-manager__color-preview" t-att-style="'background-color:' + state.newColor" />
                                <input
                                    type="text"
                                    class="tag-manager__color-hex-input"
                                    placeholder="#6b7280"
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
                            t-att-class="{ 'disabled': state.saving }"
                            t-on-click.stop.prevent="onCreateTagClick"
                        >
                            Créer
                        </a>
                        <a
                            id="tag-manager__close"
                            class="tag-manager__action tag-manager__action--close"
                            href="#"
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
        await this.saveTagsToNote();
    }

    async removeTag(tagId: string) {
        this.state.noteTags = this.state.noteTags.filter((id) => id !== tagId);
        await this.saveTagsToNote();
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
