import { useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { useFeatureSection } from "../../../utils/featureSection";
import { chatSettings, setChatSettings, ChatSettings } from "../../../services/chat/chatSettings";

export class OptionsChatComponent extends EnhancedComponent {
    static template = xml`
    <li id="chat" class="options-list__item options-sync">
      <div
        class="options-sync__header"
        role="button"
        tabindex="0"
        t-att-aria-expanded="state.expanded ? 'true' : 'false'"
        aria-controls="options-chat__body"
        t-on-click="toggleExpanded"
        t-on-keydown="(ev) => (ev.key === 'Enter' || ev.key === ' ') ? toggleExpanded() : null"
      >
        <span t-esc="t('chat.options')"/>
        <span aria-hidden="true" t-esc="state.expanded ? '▲' : '▼'" />
      </div>
      <div t-if="state.expanded" id="options-chat__body" class="options-sync__body">
        <label class="options-sync__checkbox-label">
          <input type="checkbox" t-att-checked="state.settings.sendRead" t-on-change="(ev) => this.onToggle('sendRead', ev)" />
          <t t-esc="t('chat.send_read')"/>
        </label>
        <p class="options-sync__info" t-esc="t('chat.send_read_hint')" />
        <label class="options-sync__checkbox-label">
          <input type="checkbox" t-att-checked="state.settings.sendTyping" t-on-change="(ev) => this.onToggle('sendTyping', ev)" />
          <t t-esc="t('chat.send_typing')"/>
        </label>
        <p class="options-sync__info" t-esc="t('chat.send_typing_hint')" />
      </div>
    </li>
  `;

    setup() {
        this.state = useState({ expanded: false, settings: { ...chatSettings() } });
        useFeatureSection("chat", () => { this.state.expanded = true; });
    }

    /** Stores one setting, then shows what storage holds. */
    onToggle(key: keyof ChatSettings, ev: { target: any }) {
        setChatSettings({ ...chatSettings(), [key]: !!ev.target.checked });
        this.state.settings = { ...chatSettings() };
    }

    toggleExpanded() {
        this.state.expanded = !this.state.expanded;
    }
}
