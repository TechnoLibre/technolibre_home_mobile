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
    // Reconstruct the RAW source string. The precompiler indexes
    // entries by what `source.slice(...)` extracted between the
    // backticks — i.e. the raw chars including escape sequences like
    // `\'`. Passing the full strings array to String.raw makes it
    // read `strings.raw[i]` rather than the cooked element, which is
    // the same byte sequence the precompiler saw at build time. A
    // previous version built `{ raw: strings }` which silently passed
    // the cooked array and caused runtime lookups to miss whenever a
    // template contained any escape sequence — that landed every
    // affected component on Owl's runtime compile path, blocked by
    // our `unsafe-eval`-free CSP, and blanked the page.
    const xmlSrc = String.raw(strings, ...values);
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
