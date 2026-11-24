import { onMounted, onWillUnmount, useRef, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { BackEntry } from "./chatBackEntry";
import { SheetFocus } from "./chatSheetFocus";

/** One pinned message as the panel lists it: its row key in the thread, its author, the start of its text, its date. */
export interface PinnedItem {
    key: string;
    author: string;
    snippet: string;
    date: string;
    /** Above the channel's seen message (unreadPin): listed first and marked. */
    unread: boolean;
}

/**
 * « Messages épinglés »: the pinned messages of the conversation, a sheet at
 * the bottom of the thread in the order given (the unread first), each
 * with its author, date and the start of its text; `offline` says the list
 * is the phone's alone. A tap calls onOpen with the message's row key, then
 * the panel closes over its own history entry (BackEntry), so Android's back
 * closes it too; onClose comes with the popstate. Every text is shown as
 * text (t-esc). The focus moves to the sheet and comes back on close.
 */
export class ChatPinnedComponent extends EnhancedComponent {
    static props = { items: Array, offline: Boolean, onOpen: Function, onClose: Function };

    static template = xml`
    <div class="chat-sheet" t-on-pointerdown.self="onShadeDown" t-on-click.self="onShade">
      <div class="chat-sheet__panel chat-pinned" role="dialog" aria-modal="true" tabindex="-1" t-ref="panel"
           t-att-aria-label="t('chat.pinned_messages')">
        <h3 class="chat-pinned__title" t-esc="t('chat.pinned_messages')"/>
        <p t-if="props.offline" class="chat-pinned__offline" role="status" t-esc="t('chat.pinned_offline')"/>
        <p t-if="!props.items.length" class="chat-pinned__none" t-esc="t('chat.pinned_none')"/>
        <ul t-else="" class="chat-pinned__list">
          <li t-foreach="props.items" t-as="item" t-key="item.key">
            <button type="button" class="chat-pinned__item" t-att-class="{'chat-pinned__item--unread': item.unread}"
                    t-on-click="() => this.open(item.key)">
              <span class="chat-pinned__meta">
                <span class="chat-pinned__author" t-esc="item.author"/>
                <span t-if="item.unread" class="chat-pinned__unread" t-esc="t('chat.pinned_unread')"/>
                <span class="chat-pinned__date" t-esc="item.date"/>
              </span>
              <span class="chat-pinned__snippet" t-esc="item.snippet"/>
            </button>
          </li>
        </ul>
        <button type="button" class="chat-menu__item chat-menu__close" t-on-click="() => this.close()" t-esc="t('chat.menu_close')"/>
      </div>
    </div>`;

    private panel = useRef("panel");
    private entry!: BackEntry;
    private focus = new SheetFocus();
    /** The press on the shade started there (not the tap that opened the panel). */
    shadeDown = false;
    private _onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") this.close();
    };

    setup() {
        this.entry = new BackEntry("chatPinned", () => this.props.onClose());
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

    /** A message tapped: the thread goes to it, then the panel closes. */
    open(key: string): void {
        this.props.onOpen(key);
        this.close();
    }

    onShadeDown(): void {
        this.shadeDown = true;
    }

    /** A tap on the shade closes, when the press started there. */
    onShade(): void {
        if (this.shadeDown) this.close();
        this.shadeDown = false;
    }

    close(): void {
        this.entry.close();
    }
}
