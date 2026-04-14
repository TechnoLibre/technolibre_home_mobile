import { describe, it, expect } from "vitest";
import {
    detectFileLang,
    imageMime,
    supportsHighlight,
    highlightLine,
} from "../components/options/code/syntax_highlight";

// ── detectFileLang ────────────────────────────────────────────────────────────

describe("detectFileLang", () => {
    it.each([
        ["app.py",   "python"],
        ["app.ts",   "typescript"],
        ["app.tsx",  "typescript"],
        ["app.js",   "typescript"],
        ["app.mjs",  "typescript"],
        ["app.json", "json"],
        ["app.scss", "scss"],
        ["app.css",  "scss"],
        ["app.sh",   "shell"],
        ["app.bash", "shell"],
        ["app.md",   "markdown"],
        ["app.png",  "image"],
        ["app.svg",  "image"],
        ["app.jpg",  "image"],
        ["app.webp", "image"],
    ])("maps %s → %s", (file, lang) => {
        expect(detectFileLang(file)).toBe(lang);
    });

    it("returns empty string for unknown extension", () => {
        expect(detectFileLang("app.xyz")).toBe("");
    });

    it("returns empty string when there is no extension", () => {
        expect(detectFileLang("Makefile")).toBe("");
        expect(detectFileLang("LICENSE")).toBe("");
    });

    it("is case-insensitive for extensions", () => {
        expect(detectFileLang("app.PY")).toBe("python");
        expect(detectFileLang("app.TS")).toBe("typescript");
        expect(detectFileLang("README.MD")).toBe("markdown");
    });
});

// ── imageMime ─────────────────────────────────────────────────────────────────

describe("imageMime", () => {
    it.each([
        ["photo.png",  "image/png"],
        ["photo.jpg",  "image/jpeg"],
        ["photo.jpeg", "image/jpeg"],
        ["anim.gif",   "image/gif"],
        ["icon.svg",   "image/svg+xml"],
        ["tile.webp",  "image/webp"],
        ["icon.ico",   "image/x-icon"],
        ["scan.tiff",  "image/tiff"],
        ["scan.tif",   "image/tiff"],
    ])("maps %s → %s", (file, mime) => {
        expect(imageMime(file)).toBe(mime);
    });

    it("falls back to image/octet-stream for unknown image type", () => {
        expect(imageMime("raw.bmp")).toBe("image/bmp");
        expect(imageMime("raw.xyz")).toBe("image/octet-stream");
    });
});

// ── supportsHighlight ─────────────────────────────────────────────────────────

describe("supportsHighlight", () => {
    it("returns true for supported languages", () => {
        for (const lang of ["python", "typescript", "json", "scss", "shell"] as const) {
            expect(supportsHighlight(lang)).toBe(true);
        }
    });

    it("returns false for markdown", () => {
        expect(supportsHighlight("markdown")).toBe(false);
    });

    it("returns false for image", () => {
        expect(supportsHighlight("image")).toBe(false);
    });

    it("returns false for empty lang", () => {
        expect(supportsHighlight("")).toBe(false);
    });
});

// ── highlightLine — helpers ───────────────────────────────────────────────────

/** Strip all <span ...>…</span> tags and return plain text. */
function stripHtml(html: string): string {
    return html.replace(/<\/?span[^>]*>/g, "");
}

/** Return the CSS class of the first <span> wrapping the given word. */
function classOf(html: string, word: string): string | null {
    const re = new RegExp(`<span class="hl-([^"]+)">[^<]*${word}[^<]*</span>`);
    return html.match(re)?.[1] ?? null;
}

// ── Python ────────────────────────────────────────────────────────────────────

describe("highlightLine — python", () => {
    it("highlights a keyword", () => {
        const out = highlightLine("return x", "python");
        expect(classOf(out, "return")).toBe("kw");
    });

    it("highlights a builtin", () => {
        const out = highlightLine("print(x)", "python");
        expect(classOf(out, "print")).toBe("builtin");
    });

    it("marks function name after def", () => {
        const out = highlightLine("def my_func():", "python");
        expect(classOf(out, "my_func")).toBe("fn");
    });

    it("marks class name after class", () => {
        const out = highlightLine("class MyClass:", "python");
        expect(classOf(out, "MyClass")).toBe("fn");
    });

    it("highlights a string literal", () => {
        const out = highlightLine('x = "hello"', "python");
        expect(classOf(out, "hello")).toBe("str");
    });

    it("highlights a single-quoted string", () => {
        const out = highlightLine("x = 'world'", "python");
        expect(classOf(out, "world")).toBe("str");
    });

    it("highlights a comment", () => {
        const out = highlightLine("# this is a comment", "python");
        expect(out).toContain('class="hl-comment"');
        expect(stripHtml(out)).toBe("# this is a comment");
    });

    it("highlights an integer literal", () => {
        const out = highlightLine("x = 42", "python");
        expect(classOf(out, "42")).toBe("num");
    });

    it("highlights a decorator", () => {
        const out = highlightLine("@staticmethod", "python");
        expect(classOf(out, "@staticmethod")).toBe("decorator");
    });

    it("HTML-escapes < > & in plain text", () => {
        const out = highlightLine("x = a < b & c > d", "python");
        expect(out).toContain("&lt;");
        expect(out).toContain("&gt;");
        expect(out).toContain("&amp;");
    });
});

// ── TypeScript ────────────────────────────────────────────────────────────────

describe("highlightLine — typescript", () => {
    it("highlights a keyword", () => {
        const out = highlightLine("const x = 1;", "typescript");
        expect(classOf(out, "const")).toBe("kw");
    });

    it("highlights a type keyword", () => {
        const out = highlightLine("let x: string;", "typescript");
        expect(classOf(out, "string")).toBe("type");
    });

    it("highlights a builtin", () => {
        const out = highlightLine("console.log(x);", "typescript");
        expect(classOf(out, "console")).toBe("builtin");
    });

    it("marks function name after function keyword", () => {
        const out = highlightLine("function myFn() {}", "typescript");
        expect(classOf(out, "myFn")).toBe("fn");
    });

    it("marks a call expression as fn", () => {
        const out = highlightLine("doSomething(a, b);", "typescript");
        expect(classOf(out, "doSomething")).toBe("fn");
    });

    it("highlights a // comment", () => {
        const out = highlightLine("// comment", "typescript");
        expect(out).toContain('class="hl-comment"');
    });

    it("highlights a template literal", () => {
        const out = highlightLine("const s = `hello ${name}`;", "typescript");
        expect(out).toContain('class="hl-str"');
    });

    it("highlights a double-quoted string", () => {
        const out = highlightLine('const s = "world";', "typescript");
        expect(classOf(out, "world")).toBe("str");
    });

    it("highlights a number", () => {
        const out = highlightLine("const n = 3.14;", "typescript");
        expect(classOf(out, "3.14")).toBe("num");
    });
});

// ── JSON ──────────────────────────────────────────────────────────────────────

describe("highlightLine — json", () => {
    it("highlights a string key", () => {
        const out = highlightLine('  "name": "Alice",', "json");
        expect(classOf(out, "name")).toBe("key");
    });

    it("highlights a string value", () => {
        const out = highlightLine('  "name": "Alice",', "json");
        expect(classOf(out, "Alice")).toBe("str");
    });

    it("highlights null / true / false", () => {
        for (const kw of ["null", "true", "false"]) {
            const out = highlightLine(`  "flag": ${kw}`, "json");
            expect(classOf(out, kw)).toBe("kw");
        }
    });

    it("highlights a number", () => {
        const out = highlightLine('  "count": 42', "json");
        expect(classOf(out, "42")).toBe("num");
    });

    it("highlights a negative number", () => {
        const out = highlightLine('  "delta": -7', "json");
        expect(classOf(out, "-7")).toBe("num");
    });
});

// ── SCSS ──────────────────────────────────────────────────────────────────────

describe("highlightLine — scss", () => {
    it("highlights a $variable", () => {
        const out = highlightLine("$primary-color: #fff;", "scss");
        expect(classOf(out, "\\$primary-color")).toBe("decorator");
    });

    it("highlights an @rule", () => {
        const out = highlightLine("@use 'vars';", "scss");
        expect(classOf(out, "@use")).toBe("decorator");
    });

    it("highlights a CSS variable (--var)", () => {
        const out = highlightLine("color: var(--hl-kw);", "scss");
        expect(classOf(out, "--hl-kw")).toBe("type");
    });

    it("highlights a 6-digit hex colour", () => {
        const out = highlightLine("  color: #ff0000;", "scss");
        expect(classOf(out, "#ff0000")).toBe("num");
    });

    it("highlights a // comment", () => {
        const out = highlightLine("// scss comment", "scss");
        expect(out).toContain('class="hl-comment"');
    });

    it("highlights a number with unit", () => {
        const out = highlightLine("  width: 100%;", "scss");
        expect(classOf(out, "100%")).toBe("num");
    });
});

// ── Shell ─────────────────────────────────────────────────────────────────────

describe("highlightLine — shell", () => {
    it("highlights a shell keyword", () => {
        const out = highlightLine("if [ -f file ]; then", "shell");
        expect(classOf(out, "if")).toBe("kw");
        expect(classOf(out, "then")).toBe("kw");
    });

    it("highlights a $VAR reference", () => {
        const out = highlightLine("echo $HOME", "shell");
        expect(classOf(out, "\\$HOME")).toBe("builtin");
    });

    it("highlights a ${VAR} reference", () => {
        const out = highlightLine("echo ${MY_VAR}", "shell");
        expect(classOf(out, "\\$\\{MY_VAR\\}")).toBe("builtin");
    });

    it("highlights a # comment", () => {
        const out = highlightLine("# shell comment", "shell");
        expect(out).toContain('class="hl-comment"');
    });

    it("highlights a quoted string", () => {
        const out = highlightLine('echo "hello world"', "shell");
        expect(classOf(out, "hello world")).toBe("str");
    });
});

// ── fallback / unknown lang ───────────────────────────────────────────────────

describe("highlightLine — unknown/empty lang", () => {
    it("returns HTML-escaped text with no span tags", () => {
        const out = highlightLine("x < y & z > 0", "");
        expect(out).not.toContain("<span");
        expect(out).toContain("&lt;");
        expect(out).toContain("&gt;");
        expect(out).toContain("&amp;");
    });

    it("returns plain text for markdown", () => {
        const out = highlightLine("# heading", "markdown");
        expect(out).not.toContain("<span");
        expect(out).toBe("# heading");
    });
});
