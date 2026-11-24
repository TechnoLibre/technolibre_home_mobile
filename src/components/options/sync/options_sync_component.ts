import { useState, xml } from "@odoo/owl";

import { EnhancedComponent } from "../../../js/enhancedComponent";
import { isHttpAllowed, setHttpAllowed } from "../../../services/odoo/httpPolicy";
import { reminderSettings, scheduleReminders, setReminderSettings } from "../../../services/calendarReminders";
import { attachmentSettings, setAttachmentSettings } from "../../../services/attachmentService";

export class OptionsSyncComponent extends EnhancedComponent {
  static template = xml`
    <li id="sync" class="options-list__item options-sync">
      <div
        class="options-sync__header"
        role="button"
        tabindex="0"
        t-att-aria-expanded="state.expanded ? 'true' : 'false'"
        aria-controls="options-sync__body"
        t-on-click="toggleExpanded"
        t-on-keydown="(ev) => (ev.key === 'Enter' || ev.key === ' ') ? toggleExpanded() : null"
      >
        <span t-esc="t('button.odoo_sync')"/>
        <span aria-hidden="true" t-esc="state.expanded ? '▲' : '▼'" />
      </div>
      <div t-if="state.expanded" id="options-sync__body" class="options-sync__body">
        <p class="options-sync__info" t-esc="t('message.sync_config_info')" />
        <label class="options-sync__checkbox-label">
          <input type="checkbox" t-att-checked="state.allowHttp" t-on-change="onToggleHttp" />
          <t t-esc="t('sync.allow_http')"/>
        </label>
        <p class="options-sync__info" t-esc="t('sync.allow_http_hint')" />
        <label class="options-sync__toggle">
          <input type="checkbox" t-att-checked="state.reminders.enabled" t-on-change="(ev) => this.setReminder('enabled', ev.target.checked)" />
          <t t-esc="t('sync.calendar_reminders')"/>
        </label>
        <t t-if="state.reminders.enabled">
          <label class="options-sync__info">
            <t t-esc="t('sync.calendar_reminders_hour')"/>
            <input type="number" min="0" max="23" t-att-value="state.reminders.hour" t-on-change="(ev) => this.setReminder('hour', ev.target.value)" />
          </label>
          <label class="options-sync__info">
            <t t-esc="t('sync.calendar_reminders_days')"/>
            <input type="number" min="0" max="30" t-att-value="state.reminders.daysBefore" t-on-change="(ev) => this.setReminder('daysBefore', ev.target.value)" />
          </label>
        </t>
        <p class="options-sync__info" t-esc="t('sync.calendar_reminders_hint')" />
        <label class="options-sync__toggle">
          <input type="checkbox" t-att-checked="state.attachments.wifiOnly" t-on-change="(ev) => this.setAttachments('wifiOnly', ev.target.checked)" />
          <t t-esc="t('sync.attachments_wifi')"/>
        </label>
        <label class="options-sync__info">
          <t t-esc="t('sync.attachments_max')"/>
          <input type="number" min="0" step="1" t-att-value="state.attachments.maxMb ?? ''" t-on-change="(ev) => this.setAttachments('maxMb', ev.target.value)" />
        </label>
        <p class="options-sync__info" t-esc="t('sync.attachments_hint')" />
        <button class="options-sync__btn options-sync__btn--add" t-on-click="goToApps" t-esc="t('button.go_to_applications')" />
      </div>
    </li>
  `;

  setup() {
    this.state = useState({
      expanded: false, allowHttp: isHttpAllowed(), reminders: { ...reminderSettings() }, attachments: { ...attachmentSettings() },
    });
  }

  /** Stores one attachment setting; an empty or zero size is no limit. */
  setAttachments(key: "wifiOnly" | "maxMb", value: boolean | string) {
    const current = attachmentSettings();
    const next = key === "wifiOnly"
      ? { ...current, wifiOnly: value === true }
      : { ...current, maxMb: Number(value) > 0 ? Number(value) : null };
    setAttachmentSettings(next);
    this.state.attachments = { ...attachmentSettings() };
  }

  /**
   * Stores one reminder setting; turning the reminders off cancels those
   * scheduled. The calendar's next refresh schedules them with the new
   * settings.
   */
  async setReminder(key: "enabled" | "hour" | "daysBefore", value: boolean | string) {
    setReminderSettings({ ...reminderSettings(), [key]: typeof value === "string" ? Number(value) : value });
    this.state.reminders = { ...reminderSettings() };
    if (!this.state.reminders.enabled) await scheduleReminders([]).catch(() => 0);
  }

  /** Allows or refuses http:// servers for every sync request. */
  onToggleHttp(ev: Event) {
    const allowed = (ev.target as HTMLInputElement).checked;
    setHttpAllowed(allowed);
    this.state.allowHttp = isHttpAllowed();
  }

  toggleExpanded() {
    this.state.expanded = !this.state.expanded;
  }

  goToApps() {
    this.navigate("/applications");
  }
}
