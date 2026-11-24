import { onMounted, onWillUnmount, useRef, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { t } from "../../i18n";
import type { ChatReaction } from "../../models/chat";
import { LongPress } from "./chatLongPress";
import { BackEntry } from "./chatBackEntry";
import { SheetFocus } from "./chatSheetFocus";

/** One reaction chip: the emoji, how many reacted, whether the user did, and who did by name. */
export interface ReactionView {
    content: string;
    count: number;
    self: boolean;
    names: string[];
}

/**
 * The chips of a message's reaction groups, in the server's order: the
 * partners by their cached name, then one « Guest » per guest, who are only
 * counted. The user (self, the account's partner) is always named: by the
 * cached name, else « You », and put first when the group says they
 * reacted without listing them. « Someone » is a partner never named.
 */
export function reactionViews(groups: ChatReaction[], names: Map<number, string>, self: number | null = null): ReactionView[] {
    const nameOf = (id: number) => names.get(id) || t(id === self ? "chat.you" : "chat.someone");
    return groups.map((g) => {
        const ids = g.selfReacted && self !== null && !g.partnerIds.includes(self) ? [self, ...g.partnerIds] : g.partnerIds;
        return {
            content: g.content,
            count: g.count,
            self: g.selfReacted,
            names: [...ids.map(nameOf), ...Array.from({ length: g.guestCount }, () => t("chat.guest"))],
        };
    });
}

/** What a chip's label reads: the emoji, the count, and whether the user is among them. */
export function chipLabel(r: ReactionView): string {
    return t(r.self ? "chat.reaction_chip_self" : "chat.reaction_chip", { emoji: r.content, count: r.count });
}

/**
 * A message's reaction chips, under its body and files. A tap toggles the
 * user's own reaction (onToggle); a long press asks who reacted (onWho),
 * and the click that ends it toggles nothing. A press on a chip does not
 * reach the bubble (its long press opens the message's menu).
 */
export class ChatReactionsComponent extends EnhancedComponent {
    static props = { reactions: Array, onToggle: Function, onWho: Function };

    static template = xml`
    <div class="chat-reactions" role="group" t-att-aria-label="t('chat.reactions')">
      <button t-foreach="props.reactions" t-as="r" t-key="r.content" type="button" class="chat-reactions__chip"
              t-att-class="{'chat-reactions__chip--self': r.self}" t-att-aria-pressed="r.self ? 'true' : 'false'"
              t-att-aria-label="label(r)"
              t-on-pointerdown.stop="(ev) => this.down(r, ev)" t-on-pointermove="(ev) => this.press.move(ev.clientX, ev.clientY)"
              t-on-pointerup="() => this.press.up()" t-on-pointercancel="() => this.press.cancel()"
              t-on-contextmenu.prevent="" t-on-click.stop="() => this.tap(r)">
        <span class="chat-reactions__emoji" aria-hidden="true" t-esc="r.content"/>
        <span class="chat-reactions__count" aria-hidden="true" t-esc="r.count"/>
      </button>
    </div>`;

    press = new LongPress((content) => this.props.onWho(content));

    setup() {
        onWillUnmount(() => this.press.cancel());
    }

    label(r: ReactionView): string {
        return chipLabel(r);
    }

    down(r: ReactionView, ev: PointerEvent): void {
        if (ev.button > 0) return;
        this.press.down(r.content, ev.clientX, ev.clientY);
    }

    tap(r: ReactionView): void {
        if (this.press.takeFired()) return;
        this.props.onToggle(r.content);
    }
}

/**
 * Who reacted with one emoji, a sheet at the bottom of the thread with its
 * own history entry (back closes it, as the message menu); the focus
 * comes back where it was on close (SheetFocus).
 */
export class ChatReactionWhoComponent extends EnhancedComponent {
    static props = { reaction: Object, onClose: Function };

    static template = xml`
    <div class="chat-sheet" t-on-pointerdown.self="onShadeDown" t-on-click.self="onShade">
      <div class="chat-sheet__panel chat-who" role="dialog" aria-modal="true" tabindex="-1" t-ref="panel"
           t-att-aria-label="t('chat.reaction_who', {emoji: props.reaction.content})">
        <p class="chat-who__title">
          <span aria-hidden="true" t-esc="props.reaction.content + ' ' + props.reaction.count"/>
          <span class="chat-who__label" t-esc="t('chat.reaction_who', {emoji: props.reaction.content})"/>
        </p>
        <ul class="chat-who__names">
          <li t-foreach="props.reaction.names" t-as="name" t-key="name_index" t-esc="name"/>
        </ul>
        <button type="button" class="chat-menu__item chat-menu__close" t-on-click="() => this.close()" t-esc="t('chat.menu_close')"/>
      </div>
    </div>`;

    private panel = useRef("panel");
    private entry!: BackEntry;
    private focus = new SheetFocus();
    shadeDown = false;
    private _onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") this.close();
    };

    setup() {
        this.entry = new BackEntry("chatWho", () => this.props.onClose());
        onMounted(() => {
            this.entry.open();
            document.addEventListener("keydown", this._onKey);
            this.focus.take(this.panel.el);
        });
        onWillUnmount(() => {
            document.removeEventListener("keydown", this._onKey);
            this.entry.dispose();
            this.focus.give(this.panel.el);
        });
    }

    onShadeDown(): void {
        this.shadeDown = true;
    }

    /** A tap on the shade closes, when the press started there (not the long press that opened it). */
    onShade(): void {
        if (this.shadeDown) this.close();
        this.shadeDown = false;
    }

    close(): void {
        this.entry.close();
    }
}
