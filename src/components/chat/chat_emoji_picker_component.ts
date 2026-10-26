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
 * sections are drawn at once, the others follow one per turn, and each
 * section is `content-visibility: auto` so the browser skips the ones out
 * of view: typing in the composer is never held by the 1455 buttons. The
 * buttons keep the focus where it was (mousedown prevented), so the
 * composer's keyboard stays open.
 */
export class ChatEmojiPickerComponent extends EnhancedComponent {
    static props = { onPick: Function, onClose: Function };

    static template = xml`
    <div class="chat-emoji" role="dialog" t-att-aria-label="t('chat.emoji')">
      <div class="chat-emoji__bar">
        <input class="chat-emoji__search" type="search" t-att-placeholder="t('chat.emoji_search')"
               t-att-aria-label="t('chat.emoji_search')" t-att-value="state.term" t-on-input="onSearch"/>
        <button class="chat-emoji__close" t-att-aria-label="t('chat.emoji_close')"
                t-on-mousedown.prevent="" t-on-click="() => this.props.onClose()">✕</button>
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
    private _fill: ReturnType<typeof setTimeout> | null = null;
    /** The section a tab asked for, scrolled to once it is drawn. */
    private _scrollTo: string | null = null;

    setup() {
        this.state = useState<PickerState>({ data: null, failed: false, term: "", filled: 1 });
        onMounted(() => void this.load());
        onPatched(() => this.scroll());
        onWillUnmount(() => {
            this._gone = true;
            if (this._fill) clearTimeout(this._fill);
        });
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

    /** Draws one more section on the next turn, until all are drawn. */
    private fillNext(): void {
        if (this._gone || !this.state.data) return;
        if (this.state.filled >= this.sections().length) return;
        this._fill = setTimeout(() => {
            this.state.filled++;
            this.fillNext();
        }, 0);
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
        return this.state.data ? searchEmoji(this.state.data, this.state.term, this.lang()) : [];
    }

    /** The most used emojis (when there are any) then the categories by sortId; none while searching. */
    sections(): EmojiSection[] {
        const data = this.state.data;
        if (!data || this.searching()) return [];
        const lang = this.lang();
        const byCode = new Map(data.emojis.map((e) => [e.codepoints, e]));
        const out: EmojiSection[] = [];
        const used = frequentEmoji(FREQUENT_COUNT).map((c) => byCode.get(c)).filter((e): e is EmojiEntry => !!e);
        if (used.length) out.push({ id: "frequent", title: "🕘", label: t("chat.emoji_frequent"), emojis: used });
        for (const category of [...data.categories].sort((a, b) => a.sortId - b.sortId)) {
            out.push({
                id: category.name,
                title: category.title,
                label: category.displayName[lang],
                emojis: data.emojis.filter((e) => e.category === category.name),
            });
        }
        return out;
    }

    onSearch(ev: Event): void {
        this.state.term = (ev.target as HTMLInputElement).value;
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

    /** Counts the use, then gives the emoji to the composer; the picker stays open for more. */
    pick(codepoints: string): void {
        countEmojiUse(codepoints);
        this.props.onPick(codepoints);
    }
}
