/**
 * Minimal mock of @odoo/owl.
 *
 * Only EventBus is needed for service tests.
 */
export class EventBus extends EventTarget {
  trigger(name: string, detail?: any) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
}
