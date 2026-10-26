import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import type { MessageTarget } from "../../models/chat";
import type { QuoteView } from "./chat_thread_component";

/**
 * What the composer's ➤ does: post a new message, post one that answers
 * `target` (Reply), or rewrite the user's own message `target` (Edit).
 */
export type ComposerMode =
    | { kind: "new" }
    | { kind: "reply"; target: MessageTarget }
    | { kind: "edit"; target: MessageTarget };

/**
 * The band above the composer while it replies or edits: « Replying to
 * <author> » or « Editing the message », the start of the message
 * (`quote`, as a reply's quote reads it), and ✕, which calls onCancel.
 * Shown for the reply and edit modes only.
 */
export class ChatComposerBannerComponent extends EnhancedComponent {
    static props = {
        mode: Object,
        quote: { type: [Object, { value: null }], optional: true },
        onCancel: Function,
    };

    static template = xml`
    <div class="chat-banner" t-att-class="'chat-banner--' + props.mode.kind" role="status">
      <div class="chat-banner__text">
        <b class="chat-banner__title" t-esc="title()"/>
        <span t-if="props.quote" class="chat-banner__quote" t-att-class="'chat-banner__quote--' + props.quote.state"
              t-esc="props.quote.text"/>
      </div>
      <button type="button" class="chat-banner__cancel" t-att-aria-label="cancelLabel()" t-on-click="() => props.onCancel()">✕</button>
    </div>`;

    title(): string {
        if (this.props.mode.kind === "edit") return this.t("chat.editing");
        return this.t("chat.replying_to", { name: this.props.quote?.author || this.t("chat.someone") });
    }

    cancelLabel(): string {
        return this.t(this.props.mode.kind === "edit" ? "chat.cancel_edit" : "chat.cancel_reply");
    }
}
