/**
 * Regression test for the white-screen bug that landed users on a
 * blank page after adding an audio entry.
 *
 * Root cause: the AOT precompiler indexes its PRECOMPILED entries by
 * the RAW source string between the backticks of every xml`…` literal
 * (i.e. the bytes a developer types into the source file). The
 * runtime wrapper in src/js/owl-aot.ts used to compute the COOKED
 * value of the same template literal — which is identical for plain
 * markup but DIFFERS as soon as a template contains an escape
 * sequence such as `\'` (cooked: a single apostrophe; raw: two
 * characters: backslash + apostrophe). The mismatch caused
 * PRECOMPILED[xmlSrc] to miss, the function never registered, Owl
 * fell back to its runtime template compiler, and our CSP
 * (`script-src 'self' 'unsafe-inline'`, no `'unsafe-eval'`) refused
 * to evaluate the generated JS — blanking the page.
 *
 * The audio entry's t-att-aria-label uses `\'` to embed an apostrophe
 * inside its single-quoted ternary, which is exactly the case that
 * tripped the bug on every fresh audio entry render.
 *
 * This test pins that the wrapper computes the RAW value of the
 * template literal, verified directly against String.raw, so a
 * future regression on the wrapper surfaces here rather than on
 * device.
 */
import { describe, it, expect, vi } from "vitest";

// Replace @odoo/owl with a tiny stub so we can introspect what the
// wrapper passes through. The real Owl re-exports xml verbatim, but
// we only care about how the wrapper reconstructs the source string
// it uses to look up PRECOMPILED.
let lastRegistered: { name: string; fn: unknown } | null = null;
let nextId = 1;

vi.mock("@odoo/owl/dist/owl.es.js", () => {
    function origXml(strings: TemplateStringsArray, ..._values: unknown[]): string {
        return `__template__${nextId++}`;
    }
    return {
        xml: origXml,
        App: {
            registerTemplate(name: string, fn: unknown) {
                lastRegistered = { name, fn };
            },
        },
    };
});

// PRECOMPILED is keyed by the RAW source — replicate that.
vi.mock("../__owl-precompiled__", () => {
    const fnA = () => "audio";
    const fnB = () => "plain";
    const RAW_AUDIO_SNIPPET =
        "<button aria-label=\"\\'apostrophe\\'\">x</button>";
    const RAW_PLAIN_SNIPPET =
        "<div>plain</div>";
    return {
        PRECOMPILED: {
            [RAW_AUDIO_SNIPPET]: fnA,
            [RAW_PLAIN_SNIPPET]: fnB,
        },
    };
});

import { xml } from "../js/owl-aot";

describe("owl-aot xml wrapper — raw vs cooked source string", () => {
    it("registers the precompiled fn for a plain template", () => {
        lastRegistered = null;
        xml`<div>plain</div>`;
        expect(lastRegistered).not.toBeNull();
        expect((lastRegistered as any).fn()).toBe("plain");
    });

    it("registers the precompiled fn for a template that contains a `\\'` escape", () => {
        // This mirrors the t-att-aria-label string in the audio entry
        // template. If the wrapper used cooked (single quote, 1 char)
        // instead of raw (backslash + quote, 2 chars), the PRECOMPILED
        // lookup would miss and Owl would fall through to the runtime
        // compile path that our CSP forbids.
        lastRegistered = null;
        xml`<button aria-label="\'apostrophe\'">x</button>`;
        expect(lastRegistered, "no fn registered → CSP would block on device")
            .not.toBeNull();
        expect((lastRegistered as any).fn()).toBe("audio");
    });

    it("returns the template name from origXml so Owl can locate it", () => {
        const name = xml`<div>plain</div>`;
        expect(name).toMatch(/^__template__\d+$/);
    });
});
