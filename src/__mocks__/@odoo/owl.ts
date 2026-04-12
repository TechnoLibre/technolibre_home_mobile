/**
 * Minimal mock of @odoo/owl.
 *
 * Only EventBus and reactive are needed for service tests.
 * Component is included so that EnhancedComponent (which extends it)
 * can be imported transitively without crashing in the test environment.
 */
export class Component {}

export class EventBus extends EventTarget {
  trigger(name: string, detail?: any) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
}

/** Identity function — plain objects suffice for service-layer tests. */
export function reactive<T extends object>(obj: T): T {
  return obj;
}

export const useState = reactive;
export function xml(_strings: TemplateStringsArray, ..._values: any[]): string { return ""; }
