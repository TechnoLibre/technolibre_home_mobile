import { xml } from "@odoo/owl";

import { EnhancedComponent } from "../../js/enhancedComponent";
import { suggestionText, type Suggestion } from "../../services/chat/chatMentions";

/**
 * The composer's @ and # suggestions, between the messages and the
 * composer row: each one as the text a pick writes (suggestionText), with
 * « Notify everyone » under @everyone. A tap calls onPick; the mousedown
 * is prevented, so the field keeps the focus and the keyboard stays open.
 */
export class ChatSuggestionsComponent extends EnhancedComponent {
    static props = {
        items: Array,
        onPick: Function,
    };

    static template = xml`
    <ul class="chat-suggest" t-att-aria-label="t('chat.suggestions')">
      <li t-foreach="props.items" t-as="s" t-key="keyOf(s)">
        <button type="button" class="chat-suggest__item" t-on-mousedown.prevent="" t-on-click="() => props.onPick(s)">
          <b class="chat-suggest__name" t-esc="textOf(s)"/>
          <span t-if="s.kind === 'special'" class="chat-suggest__note" t-esc="t('chat.suggest_everyone')"/>
        </button>
      </li>
    </ul>`;

    keyOf(s: Suggestion): string {
        return s.kind === "special" ? "special-" + s.label : s.kind + "-" + s.id;
    }

    textOf(s: Suggestion): string {
        return suggestionText(s);
    }
}
