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

// Lifecycle hooks: callable from a fake setup() invocation in tests so
// component code that relies on them doesn't throw at import / setup
// time. They never fire here — tests that need to exercise the body of
// onMounted / onWillDestroy capture the callback before calling.
export function onMounted(_cb: () => void): void {}
export function onWillStart(_cb: () => Promise<void> | void): void {}
export function onPatched(_cb: () => void): void {}
export function onWillDestroy(_cb: () => void): void {}
export function onWillUnmount(_cb: () => void): void {}

// Refs and the mount entry-point — accept any args, return harmless
// stubs. Real Owl behaviour (DOM mounting, reactive refs) is exercised
// in browser builds, not vitest.
export function useRef(_name: string): { el: null } { return { el: null }; }
export async function mount(..._args: unknown[]): Promise<unknown> { return null; }
export const App: any = class { static registerTemplate() {} };
