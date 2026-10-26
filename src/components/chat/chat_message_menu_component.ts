import { onMounted, onWillUnmount, useRef, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { BackEntry } from "./chatBackEntry";
import { SheetFocus } from "./chatSheetFocus";

/**
 * What the menu offers on a message, as Odoo does: react and reply on a
 * `comment` message, edit and delete on the user's own `comment` messages
 * (sent or still queued), copy on any message whose body has text.
 */
export interface MessageCan {
    react: boolean;
    reply: boolean;
    copy: boolean;
    edit: boolean;
    delete: boolean;
}

/**
 * The menu of a long-pressed message, a sheet at the bottom of the
 * thread: the six quick reactions (quickReactions) and « … » for the
 * whole picker, then Reply, Copy, Edit and Delete as `can` allows. The
 * quick emojis the user already put on the message are pressed (`active`).
 * A choice calls its prop at once (copy stays inside the tap, as the
 * clipboard asks), then the menu closes over its own history entry, so
 * Android's back closes it too; onClose comes with the popstate. A tap on
 * the shade around the sheet closes it, when the press started there: the
 * release of the long press that opened it does not. The focus moves to
 * the sheet and comes back on close (SheetFocus); the composer keeps it.
 */
export class ChatMessageMenuComponent extends EnhancedComponent {
    static props = {
        quick: Array,
        active: { type: Array, optional: true },
        can: Object,
        onReact: Function,
        onMore: Function,
        onReply: Function,
        onCopy: Function,
        onEdit: Function,
        onDelete: Function,
        onClose: Function,
    };

    static template = xml`
    <div class="chat-sheet" t-on-pointerdown.self="onShadeDown" t-on-click.self="onShade">
      <div class="chat-sheet__panel chat-menu" role="dialog" aria-modal="true" tabindex="-1" t-ref="panel"
           t-att-aria-label="t('chat.message_actions')">
        <div t-if="props.can.react" class="chat-menu__quick" role="group" t-att-aria-label="t('chat.reactions')">
          <button t-foreach="props.quick" t-as="e" t-key="e" type="button" class="chat-menu__emoji"
                  t-att-class="{'chat-menu__emoji--on': isActive(e)}" t-att-aria-pressed="isActive(e) ? 'true' : 'false'"
                  t-att-aria-label="t('chat.react_with', {emoji: e})" t-on-click="() => this.react(e)" t-esc="e"/>
          <button type="button" class="chat-menu__emoji chat-menu__more" t-att-aria-label="t('chat.react_more')"
                  t-on-click="() => this.more()">…</button>
        </div>
        <button t-if="props.can.reply" type="button" class="chat-menu__item chat-menu__reply"
                t-on-click="() => this.choose('onReply')" t-esc="t('chat.reply')"/>
        <button t-if="props.can.copy" type="button" class="chat-menu__item chat-menu__copy"
                t-on-click="() => this.choose('onCopy')" t-esc="t('chat.copy')"/>
        <button t-if="props.can.edit" type="button" class="chat-menu__item chat-menu__edit"
                t-on-click="() => this.choose('onEdit')" t-esc="t('chat.edit')"/>
        <button t-if="props.can.delete" type="button" class="chat-menu__item chat-menu__delete"
                t-on-click="() => this.choose('onDelete')" t-esc="t('chat.delete')"/>
        <button type="button" class="chat-menu__item chat-menu__close" t-on-click="() => this.close()" t-esc="t('chat.menu_close')"/>
      </div>
    </div>`;

    private panel = useRef("panel");
    private entry!: BackEntry;
    private focus = new SheetFocus();
    /** The press on the shade started there (not the long press that opened the menu). */
    shadeDown = false;
    private _onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") this.close();
    };

    setup() {
        this.entry = new BackEntry("chatMenu", () => this.props.onClose());
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

    isActive(content: string): boolean {
        return (this.props.active ?? []).includes(content);
    }

    react(content: string): void {
        this.props.onReact(content);
        this.close();
    }

    /** « … »: the thread opens the picker once the menu is gone (its history entry with it). */
    more(): void {
        this.props.onMore();
        this.close();
    }

    /** Reply, Copy, Edit or Delete: the prop is called, then the menu closes. */
    choose(action: "onReply" | "onCopy" | "onEdit" | "onDelete"): void {
        this.props[action]();
        this.close();
    }

    onShadeDown(): void {
        this.shadeDown = true;
    }

    onShade(): void {
        if (this.shadeDown) this.close();
        this.shadeDown = false;
    }

    close(): void {
        this.entry.close();
    }
}
