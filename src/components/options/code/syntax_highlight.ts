/**
 * Lightweight syntax highlighter for the Code browser.
 * Produces HTML strings with <span class="hl-{token}">…</span> markup.
 * All text is HTML-escaped before being wrapped. No external dependencies.
 */

// ── File-type detection ───────────────────────────────────────────────────────

export type FileLang =
    | "python"
    | "typescript"
    | "json"
    | "scss"
    | "shell"
    | "markdown"
    | "image"
    | "";

export function detectFileLang(fileName: string): FileLang {
    const dot = fileName.lastIndexOf(".");
    if (dot === -1) return "";
    const ext = fileName.slice(dot).toLowerCase();
    const map: Record<string, FileLang> = {
        ".py": "python",
        ".ts": "typescript", ".tsx": "typescript",
        ".js": "typescript", ".jsx": "typescript",
        ".mjs": "typescript", ".cjs": "typescript",
        ".json": "json",
        ".scss": "scss", ".css": "scss",
        ".sh": "shell", ".bash": "shell", ".zsh": "shell",
        ".md": "markdown",
        ".png": "image", ".jpg": "image", ".jpeg": "image",
        ".gif": "image", ".svg": "image", ".webp": "image",
        ".bmp": "image", ".ico": "image", ".tiff": "image", ".tif": "image",
    };
    return map[ext] ?? "";
}

export function imageMime(fileName: string): string {
    const dot = fileName.lastIndexOf(".");
    const ext = dot === -1 ? "" : fileName.slice(dot).toLowerCase();
    const map: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
        ".ico": "image/x-icon",
        ".tiff": "image/tiff", ".tif": "image/tiff",
    };
    return map[ext] ?? "image/octet-stream";
}

export function supportsHighlight(lang: FileLang): boolean {
    return lang === "python" || lang === "typescript" || lang === "json" ||
           lang === "scss" || lang === "shell";
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function esc(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function span(cls: string, text: string): string {
    return `<span class="hl-${cls}">${esc(text)}</span>`;
}

// ── Python ────────────────────────────────────────────────────────────────────

const PY_KW = new Set([
    "False", "None", "True", "and", "as", "assert", "async", "await",
    "break", "class", "continue", "def", "del", "elif", "else", "except",
    "finally", "for", "from", "global", "if", "import", "in", "is",
    "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try",
    "while", "with", "yield",
]);

const PY_BUILTIN = new Set([
    "abs", "all", "any", "bin", "bool", "breakpoint", "bytearray", "bytes",
    "callable", "chr", "classmethod", "compile", "complex", "delattr", "dict",
    "dir", "divmod", "enumerate", "eval", "exec", "filter", "float", "format",
    "frozenset", "getattr", "globals", "hasattr", "hash", "help", "hex", "id",
    "input", "int", "isinstance", "issubclass", "iter", "len", "list", "locals",
    "map", "max", "memoryview", "min", "next", "object", "oct", "open", "ord",
    "pow", "print", "property", "range", "repr", "reversed", "round", "set",
    "setattr", "slice", "sorted", "staticmethod", "str", "sum", "super",
    "tuple", "type", "vars", "zip", "self", "cls",
    "Exception", "ValueError", "TypeError", "KeyError", "IndexError",
    "AttributeError", "RuntimeError", "StopIteration", "OSError", "IOError",
    "NotImplementedError", "PermissionError", "FileNotFoundError",
]);

function tokenizePython(line: string): string {
    let out = "";
    let i = 0;
    const n = line.length;
    let prevKw = "";

    while (i < n) {
        const ch = line[i];

        // Comment
        if (ch === "#") {
            out += span("comment", line.slice(i));
            break;
        }

        // String (optional prefix f/b/r/u then quote)
        if (
            (ch === '"' || ch === "'") ||
            ("fFbBrRuU".includes(ch) && (line[i + 1] === '"' || line[i + 1] === "'"))
        ) {
            const start = i;
            if ("fFbBrRuU".includes(ch)) i++;        // consume prefix
            const q = line[i];
            const triple = q + q + q;
            if (line.slice(i, i + 3) === triple) {
                const end = line.indexOf(triple, i + 3);
                if (end !== -1) {
                    out += span("str", line.slice(start, end + 3));
                    i = end + 3;
                } else {
                    out += span("str", line.slice(start));
                    i = n;
                }
            } else {
                let j = i + 1;
                while (j < n) {
                    if (line[j] === "\\") { j += 2; continue; }
                    if (line[j] === q) { j++; break; }
                    j++;
                }
                out += span("str", line.slice(start, j));
                i = j;
            }
            prevKw = "";
            continue;
        }

        // Decorator @
        if (ch === "@") {
            let j = i + 1;
            while (j < n && /[a-zA-Z0-9_.]/.test(line[j])) j++;
            out += span("decorator", line.slice(i, j));
            i = j;
            prevKw = "";
            continue;
        }

        // Number
        if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(line[i + 1] ?? ""))) {
            let j = i;
            while (j < n && /[0-9a-fA-FxX._bBoOeEjJ]/.test(line[j])) j++;
            out += span("num", line.slice(i, j));
            i = j;
            prevKw = "";
            continue;
        }

        // Identifier / keyword / builtin / function-name
        if (/[a-zA-Z_]/.test(ch)) {
            let j = i;
            while (j < n && /[a-zA-Z0-9_]/.test(line[j])) j++;
            const word = line.slice(i, j);

            if (PY_KW.has(word)) {
                out += span("kw", word);
                prevKw = word;
            } else if (prevKw === "def" || prevKw === "class") {
                out += span("fn", word);
                prevKw = "";
            } else if (PY_BUILTIN.has(word)) {
                out += span("builtin", word);
                prevKw = "";
            } else {
                out += esc(word);
                prevKw = "";
            }
            i = j;
            continue;
        }

        // Operators
        if (/[+\-*\/=<>!&|^~%]/.test(ch)) {
            let j = i;
            while (j < n && /[+\-*\/=<>!&|^~%]/.test(line[j])) j++;
            out += span("op", line.slice(i, j));
            i = j;
            continue;
        }

        out += esc(ch);
        i++;
    }

    return out;
}

// ── TypeScript / JavaScript ───────────────────────────────────────────────────

const TS_KW = new Set([
    "break", "case", "catch", "class", "const", "continue", "debugger",
    "default", "delete", "do", "else", "export", "extends", "finally", "for",
    "function", "if", "import", "in", "instanceof", "let", "new", "of",
    "return", "static", "super", "switch", "this", "throw", "try", "typeof",
    "var", "void", "while", "with", "yield", "async", "await",
    "interface", "type", "enum", "implements", "abstract", "readonly",
    "public", "private", "protected", "declare", "namespace", "module",
    "as", "from", "override",
    "true", "false", "null", "undefined",
]);

const TS_TYPE = new Set([
    "string", "number", "boolean", "object", "any", "unknown", "never",
    "void", "symbol", "bigint",
]);

const TS_BUILTIN = new Set([
    "console", "window", "document", "Array", "Object", "String", "Number",
    "Boolean", "Symbol", "BigInt", "Date", "Math", "JSON", "Promise",
    "Map", "Set", "WeakMap", "WeakSet", "Error", "TypeError", "RangeError",
    "SyntaxError", "parseInt", "parseFloat", "isNaN", "isFinite",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "fetch", "crypto", "HTMLElement", "Element", "Event", "KeyboardEvent",
    // Owl
    "useState", "onWillDestroy", "onMounted", "onWillUnmount", "xml",
    "Component", "markup",
]);

function tokenizeTypeScript(line: string): string {
    let out = "";
    let i = 0;
    const n = line.length;
    let prevKw = "";

    while (i < n) {
        const ch = line[i];

        // // line comment
        if (ch === "/" && line[i + 1] === "/") {
            out += span("comment", line.slice(i));
            break;
        }

        // /* block comment (single-line portion) */
        if (ch === "/" && line[i + 1] === "*") {
            const end = line.indexOf("*/", i + 2);
            if (end !== -1) {
                out += span("comment", line.slice(i, end + 2));
                i = end + 2;
            } else {
                out += span("comment", line.slice(i));
                i = n;
            }
            continue;
        }

        // Template literal `...`
        if (ch === "`") {
            let j = i + 1;
            while (j < n) {
                if (line[j] === "\\") { j += 2; continue; }
                if (line[j] === "`") { j++; break; }
                j++;
            }
            out += span("str", line.slice(i, j));
            i = j;
            prevKw = "";
            continue;
        }

        // Regular strings " or '
        if (ch === '"' || ch === "'") {
            const q = ch;
            let j = i + 1;
            while (j < n) {
                if (line[j] === "\\") { j += 2; continue; }
                if (line[j] === q) { j++; break; }
                j++;
            }
            out += span("str", line.slice(i, j));
            i = j;
            prevKw = "";
            continue;
        }

        // Number
        if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(line[i + 1] ?? ""))) {
            let j = i;
            while (j < n && /[0-9a-fA-FxX._nbBoO]/.test(line[j])) j++;
            out += span("num", line.slice(i, j));
            i = j;
            prevKw = "";
            continue;
        }

        // Identifier / keyword / type / builtin
        if (/[a-zA-Z_$]/.test(ch)) {
            let j = i;
            while (j < n && /[a-zA-Z0-9_$]/.test(line[j])) j++;
            const word = line.slice(i, j);

            // Look ahead for '(' to detect function calls
            let k = j;
            while (k < n && line[k] === " ") k++;
            const nextIsCall = line[k] === "(";

            if (TS_KW.has(word)) {
                out += span("kw", word);
                prevKw = word;
            } else if (prevKw === "function" || prevKw === "class") {
                out += span("fn", word);
                prevKw = "";
            } else if (TS_TYPE.has(word)) {
                out += span("type", word);
                prevKw = "";
            } else if (TS_BUILTIN.has(word)) {
                out += span("builtin", word);
                prevKw = "";
            } else if (nextIsCall && !TS_KW.has(word)) {
                out += span("fn", word);
                prevKw = "";
            } else {
                out += esc(word);
                prevKw = "";
            }
            i = j;
            continue;
        }

        // Decorator @
        if (ch === "@") {
            let j = i + 1;
            while (j < n && /[a-zA-Z0-9_.]/.test(line[j])) j++;
            out += span("decorator", line.slice(i, j));
            i = j;
            prevKw = "";
            continue;
        }

        // Operators (single char to avoid double-handling)
        if (/[+\-*\/=<>!&|^~%?:.]/.test(ch)) {
            out += span("op", ch);
            i++;
            continue;
        }

        out += esc(ch);
        i++;
    }

    return out;
}

// ── JSON ──────────────────────────────────────────────────────────────────────

function tokenizeJson(line: string): string {
    let out = "";
    let i = 0;
    const n = line.length;

    while (i < n) {
        const ch = line[i];

        // String
        if (ch === '"') {
            let j = i + 1;
            while (j < n) {
                if (line[j] === "\\") { j += 2; continue; }
                if (line[j] === '"') { j++; break; }
                j++;
            }
            // Key if followed by ':'
            let k = j;
            while (k < n && line[k] === " ") k++;
            const isKey = line[k] === ":";
            out += span(isKey ? "key" : "str", line.slice(i, j));
            i = j;
            continue;
        }

        // Literal keywords
        const kws = ["null", "true", "false"];
        let found = false;
        for (const kw of kws) {
            if (
                line.slice(i, i + kw.length) === kw &&
                !/[a-zA-Z]/.test(line[i + kw.length] ?? "")
            ) {
                out += span("kw", kw);
                i += kw.length;
                found = true;
                break;
            }
        }
        if (found) continue;

        // Number (including negative)
        if (/[0-9\-]/.test(ch)) {
            let j = i;
            if (line[j] === "-") j++;
            if (/[0-9]/.test(line[j] ?? "")) {
                while (j < n && /[0-9.eE+\-]/.test(line[j])) j++;
                out += span("num", line.slice(i, j));
                i = j;
                continue;
            }
        }

        out += esc(ch);
        i++;
    }

    return out;
}

// ── SCSS / CSS ────────────────────────────────────────────────────────────────

function tokenizeScss(line: string): string {
    let out = "";
    let i = 0;
    const n = line.length;

    while (i < n) {
        const ch = line[i];

        // // comment
        if (ch === "/" && line[i + 1] === "/") {
            out += span("comment", line.slice(i));
            break;
        }

        // /* comment */
        if (ch === "/" && line[i + 1] === "*") {
            const end = line.indexOf("*/", i + 2);
            if (end !== -1) {
                out += span("comment", line.slice(i, end + 2));
                i = end + 2;
            } else {
                out += span("comment", line.slice(i));
                i = n;
            }
            continue;
        }

        // String
        if (ch === '"' || ch === "'") {
            const q = ch;
            let j = i + 1;
            while (j < n) {
                if (line[j] === "\\") { j += 2; continue; }
                if (line[j] === q) { j++; break; }
                j++;
            }
            out += span("str", line.slice(i, j));
            i = j;
            continue;
        }

        // CSS variable --name
        if (ch === "-" && line[i + 1] === "-") {
            let j = i;
            while (j < n && /[a-zA-Z0-9_\-]/.test(line[j])) j++;
            out += span("type", line.slice(i, j));
            i = j;
            continue;
        }

        // @rule or $variable
        if (ch === "@" || ch === "$") {
            let j = i + 1;
            while (j < n && /[a-zA-Z0-9_\-]/.test(line[j])) j++;
            out += span("decorator", line.slice(i, j));
            i = j;
            continue;
        }

        // # hex color (3 or 6 hex digits)
        if (ch === "#") {
            let j = i + 1;
            while (j < n && /[a-fA-F0-9]/.test(line[j])) j++;
            const hexLen = j - i - 1;
            if (hexLen === 3 || hexLen === 6 || hexLen === 8) {
                out += span("num", line.slice(i, j));
                i = j;
            } else {
                out += esc(ch);
                i++;
            }
            continue;
        }

        // Number with optional unit
        if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(line[i + 1] ?? ""))) {
            let j = i;
            while (j < n && /[0-9.]/.test(line[j])) j++;
            while (j < n && /[a-zA-Z%]/.test(line[j])) j++;
            out += span("num", line.slice(i, j));
            i = j;
            continue;
        }

        out += esc(ch);
        i++;
    }

    return out;
}

// ── Shell ─────────────────────────────────────────────────────────────────────

const SH_KW = new Set([
    "if", "then", "else", "elif", "fi", "for", "while", "do", "done",
    "case", "esac", "function", "return", "exit", "export", "local",
    "readonly", "source", "shift", "break", "continue", "in", "until",
    "select", "echo", "printf",
]);

function tokenizeShell(line: string): string {
    let out = "";
    let i = 0;
    const n = line.length;

    while (i < n) {
        const ch = line[i];

        // Comment
        if (ch === "#") {
            out += span("comment", line.slice(i));
            break;
        }

        // String
        if (ch === '"' || ch === "'") {
            const q = ch;
            let j = i + 1;
            while (j < n) {
                if (q === '"' && line[j] === "\\") { j += 2; continue; }
                if (line[j] === q) { j++; break; }
                j++;
            }
            out += span("str", line.slice(i, j));
            i = j;
            continue;
        }

        // Variable $VAR or ${VAR} or $0-$9
        if (ch === "$") {
            if (line[i + 1] === "{") {
                const end = line.indexOf("}", i + 2);
                const j = end !== -1 ? end + 1 : n;
                out += span("builtin", line.slice(i, j));
                i = j;
            } else {
                let j = i + 1;
                while (j < n && /[a-zA-Z0-9_]/.test(line[j])) j++;
                out += span("builtin", line.slice(i, j));
                i = j;
            }
            continue;
        }

        // Identifier / keyword
        if (/[a-zA-Z_]/.test(ch)) {
            let j = i;
            while (j < n && /[a-zA-Z0-9_\-]/.test(line[j])) j++;
            const word = line.slice(i, j);
            out += SH_KW.has(word) ? span("kw", word) : esc(word);
            i = j;
            continue;
        }

        out += esc(ch);
        i++;
    }

    return out;
}

// ── Public entry point ────────────────────────────────────────────────────────

export function highlightLine(line: string, lang: FileLang): string {
    switch (lang) {
        case "python":     return tokenizePython(line);
        case "typescript": return tokenizeTypeScript(line);
        case "json":       return tokenizeJson(line);
        case "scss":       return tokenizeScss(line);
        case "shell":      return tokenizeShell(line);
        default:           return esc(line);
    }
}
