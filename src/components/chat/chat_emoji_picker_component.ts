import { onMounted, onPatched, onWillUnmount, useRef, useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { getCurrentLocale, t } from "../../i18n";
import {
    countEmojiUse,
    frequentEmoji,
    loadEmojiData,
    searchEmoji,
} from "../../services/chat/chatEmoji";
import type { EmojiData, EmojiEntry } from "../../services/chat/chatEmoji";

/** Most used emojis the first section lists (Odoo's picker shows 42). */
const FREQUENT_COUNT = 42;

/** One block of the grid: the most used emojis or a category, with its tab. */
export interface EmojiSection {
    id: string;
    /** The tab: the category's emoji, 🕘 for the most used. */
    title: string;
    label: string;
    emojis: EmojiEntry[];
}

interface PickerState {
    data: EmojiData | null;
    failed: boolean;
    term: string;
    /** Sections drawn so far; the rest follow one per turn so the first paint is short. */
    filled: number;
}

/**
 * The emoji picker: the most used emojis, then Odoo's categories in their
 * order with a tab each, and a search field in the app's language. The data
 * is a chunk of its own, asked on mount behind a spinner. Only the first
 * sections are drawn at once, the others follow one per frame, and each
 * section is `content-visibility: auto` so the browser skips the ones out
 * of view: typing in the composer is never held by the 1455 buttons. The
 * buttons keep the focus where it was (mousedown prevented), so the
 * composer's keyboard stays open.
 */
export class ChatEmojiPickerComponent extends EnhancedComponent {
    static props = { onPick: Function, onClose: Function, countUse: { type: Boolean, optional: true } };

    static template = xml`
    <div class="chat-emoji" role="dialog" t-att-aria-label="t('chat.emoji')">
      <div class="chat-emoji__bar">
        <input class="chat-emoji__search" type="search" t-att-placeholder="t('chat.emoji_search')"
               t-att-aria-label="t('chat.emoji_search')" t-att-value="state.term" t-on-input="onSearch"/>
        <button class="chat-emoji__close" t-att-aria-label="t('chat.emoji_close')"
                t-on-mousedown.prevent="" t-on-click="() => this.close()">✕</button>
      </div>
      <p t-if="!state.data and !state.failed" class="chat-emoji__status" role="status" t-esc="t('chat.emoji_loading')"/>
      <div t-if="state.failed" class="chat-emoji__status" role="alert">
        <span t-esc="t('chat.emoji_failed')"/>
        <button class="chat-emoji__retry" t-on-click="() => this.load()" t-esc="t('chat.retry')"/>
      </div>
      <t t-if="state.data">
        <t t-if="searching()">
          <p t-if="!found().length" class="chat-emoji__status" role="status" t-esc="t('chat.emoji_none')"/>
          <div class="chat-emoji__grid chat-emoji__grid--found">
            <button t-foreach="found()" t-as="e" t-key="e.codepoints" class="chat-emoji__item" type="button"
                    t-att-aria-label="nameOf(e)" t-on-mousedown.prevent="" t-on-click="() => this.pick(e.codepoints)" t-esc="e.codepoints"/>
          </div>
        </t>
        <t t-else="">
          <div class="chat-emoji__tabs" role="tablist">
            <button t-foreach="sections()" t-as="s" t-key="s.id" class="chat-emoji__tab" type="button" role="tab"
                    t-att-aria-label="s.label" t-on-mousedown.prevent="" t-on-click="() => this.goTo(s.id)" t-esc="s.title"/>
          </div>
          <div class="chat-emoji__sections" t-ref="sections">
            <section t-foreach="sections()" t-as="s" t-key="s.id" class="chat-emoji__section"
                     t-att-data-section="s.id">
              <h3 class="chat-emoji__title" t-esc="s.label"/>
              <div t-if="s_index &lt; state.filled" class="chat-emoji__grid">
                <button t-foreach="s.emojis" t-as="e" t-key="e.codepoints" class="chat-emoji__item" type="button"
                        t-att-aria-label="nameOf(e)" t-on-mousedown.prevent="" t-on-click="() => this.pick(e.codepoints)" t-esc="e.codepoints"/>
              </div>
            </section>
          </div>
        </t>
      </t>
    </div>`;

    state!: PickerState;
    private _list = useRef("sections");
    private _gone = false;
    private _fill: number | null = null;
    /** The section a tab asked for, scrolled to once it is drawn. */
    private _scrollTo: string | null = null;
    /** The picker's history entry is the current one: Android's back closes it, not the conversation. */
    private _inHistory = false;
    private _closing = false;
    /** A popstate onto an entry still marked chatEmoji is a sheet above the picker going back: the picker stays. */
    private _onPop = () => {
        if (!this._inHistory || window.history.state?.chatEmoji) return;
        this._inHistory = false;
        this.props.onClose();
    };
    private _onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") this.close();
    };
    /** sections() and found() are computed once per input, not once per use in the template. */
    private _sectionsKey = "";
    private _sections: EmojiSection[] = [];
    private _sectionsData: EmojiData | null = null;
    private _foundKey: [EmojiData | null, string, string] = [null, "", ""];
    private _found: EmojiEntry[] = [];

    setup() {
        this.state = useState<PickerState>({ data: null, failed: false, term: "", filled: 1 });
        onMounted(() => {
            window.history.pushState({ ...(window.history.state ?? {}), chatEmoji: true }, "");
            this._inHistory = true;
            window.addEventListener("popstate", this._onPop);
            document.addEventListener("keydown", this._onKey);
            void this.load();
        });
        onPatched(() => this.scroll());
        onWillUnmount(() => {
            this._gone = true;
            if (this._fill) cancelAnimationFrame(this._fill);
            window.removeEventListener("popstate", this._onPop);
            document.removeEventListener("keydown", this._onKey);
            // Closed without a back: its entry, if still the current one, is gone with it
            if (this._inHistory && window.history.state?.chatEmoji) window.history.back();
            this._inHistory = false;
        });
    }

    /**
     * ✕ and Escape: goes back over the picker's entry, whose popstate closes
     * it; a second call before that popstate does nothing, so a double tap
     * never leaves the conversation.
     */
    close(): void {
        if (this._closing) return;
        if (this._inHistory) {
            this._closing = true;
            window.history.back();
        } else {
            this.props.onClose();
        }
    }

    /** Asks the data (the same promise every time); a failure offers a retry. */
    async load(): Promise<void> {
        this.state.failed = false;
        try {
            const data = await loadEmojiData();
            if (this._gone) return;
            this.state.data = data;
            this.state.filled = 1;
            this.fillNext();
        } catch (e) {
            console.warn("chat emoji: data unavailable", e);
            if (!this._gone) this.state.failed = true;
        }
    }

    /** Draws one more section on the next frame, until all are drawn. */
    private fillNext(): void {
        if (this._gone || !this.state.data) return;
        if (this.state.filled >= this.sections().length) return;
        // One frame each: Owl paints on a frame, so a step queued after it lands on the next one
        this._fill = requestAnimationFrame(() => {
            this.state.filled++;
            this.fillNext();
        });
    }

    private lang(): "fr" | "en" {
        return getCurrentLocale() === "en" ? "en" : "fr";
    }

    nameOf(e: EmojiEntry): string {
        return e.name[this.lang()];
    }

    searching(): boolean {
        return this.state.term.trim() !== "";
    }

    /** The emojis matching the search field, in data order. */
    found(): EmojiEntry[] {
        const key: [EmojiData | null, string, string] = [this.state.data, this.state.term, this.lang()];
        if (this._foundKey.some((v, i) => v !== key[i])) {
            this._found = key[0] ? searchEmoji(key[0], key[1], key[2] as "fr" | "en") : [];
            this._foundKey = key;
        }
        return this._found;
    }

    /** The most used emojis (when there are any) then the categories by sortId; none while searching. */
    sections(): EmojiSection[] {
        const data = this.state.data;
        if (!data || this.searching()) return [];
        const lang = this.lang();
        const frequent = frequentEmoji(FREQUENT_COUNT);
        const key = lang + "|" + frequent.join(",");
        if (this._sectionsKey === key && this._sectionsData === data) return this._sections;
        const byCode = new Map(data.emojis.map((e) => [e.codepoints, e]));
        const out: EmojiSection[] = [];
        const used = frequent.map((c) => byCode.get(c)).filter((e): e is EmojiEntry => !!e);
        if (used.length) out.push({ id: "frequent", title: "🕘", label: t("chat.emoji_frequent"), emojis: used });
        for (const category of [...data.categories].sort((a, b) => a.sortId - b.sortId)) {
            out.push({
                id: category.name,
                title: category.title,
                label: category.displayName[lang],
                emojis: data.emojis.filter((e) => e.category === category.name),
            });
        }
        this._sectionsKey = key;
        this._sectionsData = data;
        this._sections = out;
        return out;
    }

    /**
     * The search field changed. Back to empty, the sections are mounted
     * again: only the first at once, the others one per turn, never the
     * whole list in one render.
     */
    onSearch(ev: Event): void {
        const was = this.searching();
        this.state.term = (ev.target as HTMLInputElement).value;
        if (was && !this.searching()) {
            this.state.filled = 1;
            this.fillNext();
        }
    }

    /** A tab: draws every section (the one asked may be a late one), then scrolls to it. */
    goTo(id: string): void {
        this.state.filled = this.sections().length;
        this._scrollTo = id;
        this.scroll();
    }

    private scroll(): void {
        const id = this._scrollTo;
        const list = this._list.el;
        if (!id || !list) return;
        const target = Array.from(list.querySelectorAll<HTMLElement>("[data-section]"))
            .find((el) => el.dataset.section === id);
        if (!target) return;
        this._scrollTo = null;
        list.scrollTop = target.offsetTop - list.offsetTop;
    }

    /**
     * Counts the use (unless countUse is false: a reaction counts its own),
     * then gives the emoji to the caller; typing into the composer, the
     * picker stays open for more.
     */
    pick(codepoints: string): void {
        if (this.props.countUse !== false) countEmojiUse(codepoints);
        this.props.onPick(codepoints);
    }
}
