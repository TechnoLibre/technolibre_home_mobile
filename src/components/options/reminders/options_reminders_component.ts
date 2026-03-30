import { onMounted, useState, xml } from "@odoo/owl";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { ReminderService, Reminder, INTERVAL_OPTIONS } from "../../../services/reminderService";

export class OptionsRemindersComponent extends EnhancedComponent {
  static template = xml`
    <li class="options-list__item options-reminders">
      <div class="options-reminders__header" t-on-click="toggleExpanded">
        <span>🔔 Rappels personnels</span>
        <span class="options-reminders__count" t-if="activeCount > 0">
          <t t-esc="activeCount"/> actif(s)
        </span>
        <span t-esc="state.expanded ? '▲' : '▼'" />
      </div>

      <div t-if="state.expanded" class="options-reminders__body">

        <!-- New reminder form -->
        <div class="options-reminders__form">
          <label class="options-reminders__label">Message</label>
          <input
            class="options-reminders__input"
            type="text"
            placeholder="ex: Boire un verre d'eau"
            maxlength="120"
            t-att-value="state.draft.message"
            t-on-input="onMessageInput"
          />

          <label class="options-reminders__label">Intervalle</label>
          <select class="options-reminders__select" t-on-change="onIntervalChange">
            <t t-foreach="intervals" t-as="opt" t-key="opt.minutes">
              <option
                t-att-value="opt.minutes"
                t-att-selected="state.draft.intervalMinutes === opt.minutes"
                t-esc="opt.label"
              />
            </t>
          </select>

          <button
            class="options-reminders__btn options-reminders__btn--add"
            t-att-disabled="!state.draft.message.trim() or state.isBusy"
            t-on-click="addReminder"
          >
            <t t-if="state.isBusy">⟳</t>
            <t t-else="">+ Ajouter ce rappel</t>
          </button>
        </div>

        <!-- Active reminders list -->
        <ul t-if="state.reminders.length" class="options-reminders__list">
          <li
            t-foreach="state.reminders"
            t-as="reminder"
            t-key="reminder.id"
            class="options-reminders__item"
          >
            <div class="options-reminders__item-info">
              <span class="options-reminders__item-msg" t-esc="reminder.message" />
              <span class="options-reminders__item-meta">
                <t t-esc="intervalLabel(reminder.intervalMinutes)" />
                — <span t-att-class="'options-reminders__status options-reminders__status--' + (reminder.active ? 'active' : 'paused')">
                  <t t-esc="reminder.active ? 'actif' : 'pausé'" />
                </span>
              </span>
            </div>
            <div class="options-reminders__item-actions">
              <button
                class="options-reminders__btn options-reminders__btn--toggle"
                t-att-disabled="state.isBusy"
                t-on-click="() => toggleReminder(reminder)"
                t-esc="reminder.active ? '⏸' : '▶'"
              />
              <button
                class="options-reminders__btn options-reminders__btn--delete"
                t-att-disabled="state.isBusy"
                t-on-click="() => deleteReminder(reminder)"
              >✕</button>
            </div>
          </li>
        </ul>

        <p t-if="!state.reminders.length" class="options-reminders__empty">
          Aucun rappel configuré.
        </p>

        <p t-if="state.error" class="options-reminders__error" t-esc="state.error" />
      </div>
    </li>
  `;

  private svc!: ReminderService;

  setup() {
    this.svc = new ReminderService(this.databaseService);
    this.state = useState({
      expanded: false,
      reminders: [] as Reminder[],
      draft: { message: "", intervalMinutes: 30 },
      isBusy: false,
      error: "",
    });
    onMounted(() => this.loadReminders());
  }

  get intervals() {
    return INTERVAL_OPTIONS;
  }

  get activeCount(): number {
    return this.state.reminders.filter((r: Reminder) => r.active).length;
  }

  intervalLabel(minutes: number): string {
    return INTERVAL_OPTIONS.find((o) => o.minutes === minutes)?.label
      ?? `${minutes} min`;
  }

  toggleExpanded() {
    this.state.expanded = !this.state.expanded;
  }

  onMessageInput(e: Event) {
    this.state.draft.message = (e.target as HTMLInputElement).value;
  }

  onIntervalChange(e: Event) {
    this.state.draft.intervalMinutes = parseInt(
      (e.target as HTMLSelectElement).value,
      10
    );
  }

  async addReminder() {
    const { message, intervalMinutes } = this.state.draft;
    if (!message.trim() || this.state.isBusy) return;

    this.state.isBusy = true;
    this.state.error = "";
    try {
      const granted = await this.svc.requestPermission();
      if (!granted) {
        this.state.error = "Permission de notification refusée.";
        return;
      }
      let reminder = this.svc.create(message.trim(), intervalMinutes);
      reminder = await this.svc.activate(reminder);

      const updated = [...this.state.reminders, reminder];
      await this.svc.saveAll(updated);
      this.state.reminders = updated;
      this.state.draft.message = "";
    } catch (e: unknown) {
      this.state.error = `Erreur : ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      this.state.isBusy = false;
    }
  }

  async toggleReminder(reminder: Reminder) {
    if (this.state.isBusy) return;
    this.state.isBusy = true;
    this.state.error = "";
    try {
      const updated = reminder.active
        ? await this.svc.deactivate(reminder)
        : await this.svc.activate(reminder);

      const list = this.state.reminders.map((r: Reminder) =>
        r.id === reminder.id ? updated : r
      );
      await this.svc.saveAll(list);
      this.state.reminders = list;
    } catch (e: unknown) {
      this.state.error = `Erreur : ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      this.state.isBusy = false;
    }
  }

  async deleteReminder(reminder: Reminder) {
    if (this.state.isBusy) return;
    this.state.isBusy = true;
    this.state.error = "";
    try {
      await this.svc.deactivate(reminder);
      const list = this.state.reminders.filter((r: Reminder) => r.id !== reminder.id);
      await this.svc.saveAll(list);
      this.state.reminders = list;
    } catch (e: unknown) {
      this.state.error = `Erreur : ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      this.state.isBusy = false;
    }
  }

  private async loadReminders() {
    this.state.reminders = await this.svc.loadAll();
  }
}
