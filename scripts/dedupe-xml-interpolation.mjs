#!/usr/bin/env node
// One-shot codemod that removes interpolation from xml template literals
// so the AOT precompile pipeline can cover 100% of templates.
//
// Per-file strategy:
//   1. Find the xml block (multi-line string literal in static template field).
//   2. For each substitution slot inside, replace with the equivalent Owl
//      directive bound to a property whose name is camelCased from the ident.
//   3. Inject the corresponding instance field on the class right after
//      the class header so the original import is exposed.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(join(__filename, "..", ".."));

const FILES = [
    "src/components/note_list/note_list_component.ts",
    "src/components/video_camera/video_camera_component.ts",
    "src/components/applications/item/applications_item_component.ts",
    "src/components/note/bottom_controls/note_bottom_controls_component.ts",
    "src/components/note_entry/audio/note_entry_audio_component.ts",
    "src/components/note_entry/delete/note_entry_delete_component.ts",
    "src/components/note_entry/drag/note_entry_drag_component.ts",
    "src/components/note_entry/photo/note_entry_photo_component.ts",
    "src/components/note_entry/video/note_entry_video_component.ts",
    "src/components/note_list/controls/note_list_controls_component.ts",
    "src/components/note_list/item/note_list_item_component.ts",
    "src/components/note/top_controls/note_top_controls_component.ts",
    "src/components/options/erplibre/options_erplibre_component.ts",
    "src/components/intent-handler/note/image/note_image_intent_handler_component.ts",
    "src/components/intent-handler/note/text/note_text_intent_handler_component.ts",
    "src/components/intent-handler/note/video/note_video_intent_handler_component.ts",
    "src/components/note_list/item/handle/note_list_item_handle_component.ts",
];

function camelize(expr) {
    if (expr.includes(".")) {
        const last = expr.split(".").pop();
        return last.charAt(0).toLowerCase() + last.slice(1);
    }
    return expr.charAt(0).toLowerCase() + expr.slice(1);
}

function findXmlBlock(src) {
    const marker = "static template = xml`";
    const start = src.indexOf(marker);
    if (start < 0) return null;
    let i = start + marker.length;
    while (i < src.length) {
        const c = src[i];
        if (c === "\\") { i += 2; continue; }
        if (c === "`") return { contentStart: start + marker.length, contentEnd: i };
        i++;
    }
    return null;
}

function refactorOne(filePath) {
    const fullPath = join(ROOT, filePath);
    const src = readFileSync(fullPath, "utf-8");

    const block = findXmlBlock(src);
    if (!block) {
        console.warn(`[skip] ${filePath} — no xml template`);
        return;
    }
    const before = src.slice(0, block.contentStart);
    const xmlBody = src.slice(block.contentStart, block.contentEnd);
    const after = src.slice(block.contentEnd);

    if (!xmlBody.includes("$" + "{")) {
        return;
    }

    const seen = new Map();
    const placeholderPrefix = "__OWL_AOT_HOLE__";

    // Pass 1: replace every interpolation with a placeholder.
    const interpRe = /\$\{([A-Za-z_$][\w.$]*)\}/g;
    let body = xmlBody.replace(interpRe, (_m, expr) => {
        seen.set(expr, camelize(expr));
        return placeholderPrefix + expr + "__";
    });

    // Pass 2: convert attribute uses (foo="HOLE") to t-att-foo="propName".
    body = body.replace(
        new RegExp("([a-zA-Z-]+)=\"" + placeholderPrefix + "([A-Za-z_$][\\w.$]*)__\"", "g"),
        (_m, attrName, expr) => {
            const propName = camelize(expr);
            if (attrName.startsWith("t-att-") || attrName.startsWith("t-on-")) {
                return attrName + "=\"" + propName + "\"";
            }
            return "t-att-" + attrName + "=\"" + propName + "\"";
        },
    );

    // Pass 3: any remaining placeholder is in text content; emit t-esc.
    body = body.replace(
        new RegExp(placeholderPrefix + "([A-Za-z_$][\\w.$]*)__", "g"),
        (_m, expr) => "<t t-esc=\"" + camelize(expr) + "\"/>",
    );

    // Inject instance fields after the class header.
    let modBefore = before;
    const classRe = /(extends\s+\w+\s*\{)/;
    const m = classRe.exec(modBefore);
    if (!m) {
        console.warn(`[warn] ${filePath} — no class header, skipping field injection`);
        writeFileSync(fullPath, modBefore + body + after);
        return;
    }
    const insertAt = m.index + m[0].length;
    const lines = [
        "",
        "    // Module-level constants exposed to the static template so the xml`...`",
        "    // literal stays interpolation-free and AOT-precompilable.",
    ];
    for (const [expr, propName] of seen) {
        lines.push("    " + propName + " = " + expr + ";");
    }
    lines.push("");
    modBefore = modBefore.slice(0, insertAt) + lines.join("\n") + modBefore.slice(insertAt);

    writeFileSync(fullPath, modBefore + body + after);
    console.log("[ok] " + filePath + " — " + seen.size + " props (" + [...seen.keys()].join(", ") + ")");
}

for (const f of FILES) refactorOne(f);
