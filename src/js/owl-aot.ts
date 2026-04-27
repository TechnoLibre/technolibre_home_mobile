/**
 * AOT (ahead-of-time) wrapper around @odoo/owl.
 *
 * Re-exports everything from the upstream package, but overrides `xml` so
 * that templates with a pre-compiled counterpart in __owl-precompiled__.ts
 * get registered as functions on Owl's globalTemplates via
 * `App.registerTemplate`. When Owl later calls `App.getTemplate(name)`, it
 * sees a function (not a string) and returns it directly — bypassing the
 * runtime template-compile path that requires `'unsafe-eval'`.
 *
 * vite.config.ts aliases `@odoo/owl` (exact match) to this file. The
 * wrapper's own import targets the package's full file path so the alias
 * does not trip over itself.
 */

import { xml as origXml, App } from "@odoo/owl/dist/owl.es.js";
import { PRECOMPILED } from "../__owl-precompiled__";

// Re-export everything from upstream — `xml` will be overridden below.
export * from "@odoo/owl/dist/owl.es.js";

export function xml(
    strings: TemplateStringsArray,
    ...values: unknown[]
): string {
    // Reconstruct the source string the same way Owl's xml does internally.
    const xmlSrc = String.raw(
        { raw: strings as unknown as string[] } as TemplateStringsArray,
        ...values,
    );
    const name = origXml(strings, ...values);
    const fn = PRECOMPILED[xmlSrc];
    if (fn) {
        // Overrides the string previously stored by origXml with the pre-compiled
        // function. Owl's getTemplate() then short-circuits the compile step.
        (App as unknown as {
            registerTemplate: (name: string, fn: typeof fn) => void;
        }).registerTemplate(name, fn);
    }
    return name;
}
