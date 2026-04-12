import { onMounted, useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { Events } from "../../constants/events";
import { Note } from "../../models/note";
import { Tag } from "../../models/tag";
import { NotesItemComponent } from "../note_list/item/note_list_item_component";

interface TagNotesState {
    tag: Tag | null;
    childTags: Tag[];
    notes: Note[];
    loaded: boolean;
}

export class TagNotesComponent extends EnhancedComponent {
    state!: TagNotesState;

    static components = { NotesItemComponent };

    static template = xml`
        <div id="tag-notes-component">

            <!-- Header -->
            <nav class="tag-notes__breadcrumb">
                <a href="#" t-on-click.stop.prevent="onBackClick">Accueil</a>
                <span class="tag-notes__sep">›</span>
                <span
                    t-if="state.tag"
                    class="tag-notes__current-tag"
                    t-att-style="'--tag-color:' + state.tag.color"
                    t-esc="state.tag.name"
                />
            </nav>

            <t t-if="state.loaded">

                <!-- Child tag navigation -->
                <div t-if="state.childTags.length > 0" id="tag-notes__children">
                    <p class="tag-notes__section-label">Sous-tags</p>
                    <div class="tag-notes__child-chips">
                        <button
                            t-foreach="state.childTags"
                            t-as="child"
                            t-key="child.id"
                            class="tag-notes__child-chip"
                            t-att-style="'--tag-color:' + child.color"
                            t-on-click.stop.prevent="() => this.onChildTagClick(child.id)"
                        >
                            <t t-esc="child.name" />
                            <span class="tag-notes__child-chip-arrow">›</span>
                        </button>
                    </div>
                </div>

                <!-- Filtered notes -->
                <div id="tag-notes__list">
                    <p class="tag-notes__section-label">
                        <t t-esc="state.notes.length" />
                        note<t t-if="state.notes.length !== 1">s</t>
                    </p>
                    <ul class="tag-notes__note-list" t-if="state.notes.length > 0">
                        <NotesItemComponent
                            t-foreach="state.notes"
                            t-as="note"
                            t-key="note.id"
                            note="note"
                            editMode="false"
                            syncSynced="0"
                            syncError="0"
                            openNote.bind="openNote"
                            editNote.bind="openNote"
                            deleteNote.bind="deleteNote"
                            onSort.bind="noop"
                        />
                    </ul>
                    <p t-else="" class="tag-notes__empty">
                        Aucune note pour ce tag.
                    </p>
                </div>

            </t>
            <t t-else="">
                <p class="tag-notes__loading">Chargement…</p>
            </t>

        </div>
    `;

    setup() {
        this.state = useState<TagNotesState>({
            tag: null,
            childTags: [],
            notes: [],
            loaded: false,
        });
        onMounted(() => this.load());
    }

    private getTagId(): string {
        const params = this.router.getRouteParams(window.location.pathname);
        return decodeURIComponent(params?.get("id") ?? "");
    }

    async load() {
        const tagId = this.getTagId();
        if (!tagId) {
            this.state.loaded = true;
            return;
        }

        // Load tags cache first (needed by NotesItemComponent)
        await this.tagService.getAllTags();

        const [tag, childTags, descendantIds] = await Promise.all([
            this.tagService.getTagById(tagId),
            this.tagService.getChildTags(tagId),
            this.tagService.getAllDescendantIds(tagId),
        ]);

        this.state.tag = tag;
        this.state.childTags = childTags;

        // Notes that carry this tag OR any descendant tag
        const relevantIds = new Set([tagId, ...descendantIds]);
        const allNotes = await this.noteService.getNotes();
        this.state.notes = allNotes.filter(
            (n) => !n.archived && n.tags.some((id) => relevantIds.has(id))
        );

        this.state.loaded = true;
    }

    onBackClick() {
        this.eventBus.trigger(Events.ROUTER_NAVIGATION, { url: "/" });
    }

    onChildTagClick(tagId: string) {
        this.eventBus.trigger(Events.ROUTER_NAVIGATION, { url: `/tags/${tagId}` });
    }

    openNote(noteId: string) {
        this.eventBus.trigger(Events.ROUTER_NAVIGATION, {
            url: `/note/${encodeURIComponent(noteId)}`,
        });
    }

    async deleteNote(noteId: string) {
        const confirmed = confirm("Supprimer cette note ?");
        if (!confirmed) return;
        try {
            await this.noteService.crud.delete(noteId);
            this.state.notes = this.state.notes.filter((n) => n.id !== noteId);
        } catch {
            // ignore
        }
    }

    noop() {}
}
