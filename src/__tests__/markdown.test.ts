import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
	renderMarkdown,
	escHtml,
	applyInline,
} from "../components/options/code/markdown";

describe("escHtml", () => {
	it("neutralises the four characters that could close a tag", () => {
		expect(escHtml('<a href="x">&')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
	});
});

describe("applyInline", () => {
	it("renders bold, italic, code and links", () => {
		expect(applyInline("**b** *i* `c` [t](http://u)")).toBe(
			'<strong>b</strong> <em>i</em> <code class="md-inline-code">c</code>'
				+ ' <span class="md-link">t</span>',
		);
	});
});

describe("renderMarkdown — tables", () => {
	// C'était le manque : la documentation du dépôt est faite de tableaux, et
	// sans eux le lecteur affichait des rangées de barres verticales.
	const TABLE = "| Méthode | Description |\n|---|---|\n| `a()` | fait a |\n| `b()` | fait b |";

	it("turns a pipe table into a real table", () => {
		const html = renderMarkdown(TABLE);
		expect(html).toContain('<table class="md-table">');
		expect(html).toContain("<thead>");
		expect((html.match(/<tr>/g) ?? []).length).toBe(3);
		expect(html).toContain("Méthode");
		expect(html).toContain('<code class="md-inline-code">a()</code>');
	});

	it("wraps it so a wide table scrolls instead of widening the page", () => {
		expect(renderMarkdown(TABLE)).toContain('<div class="md-table-wrap">');
	});

	it("reads the alignment row", () => {
		const html = renderMarkdown("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |");
		expect(html).toContain("md-td--left");
		expect(html).toContain("md-td--center");
		expect(html).toContain("md-td--right");
	});

	it("accepts rows without the edge pipes", () => {
		const html = renderMarkdown("a | b\n--- | ---\n1 | 2");
		expect(html).toContain('<table class="md-table">');
	});

	it("pads a short row rather than dropping the table", () => {
		const html = renderMarkdown("| a | b |\n|---|---|\n| 1 |");
		expect(html).toContain('<table class="md-table">');
		expect((html.match(/<td/g) ?? []).length).toBe(2);
	});

	it("leaves a pipe line alone when no alignment row follows", () => {
		const html = renderMarkdown("a | b | c");
		expect(html).not.toContain("md-table");
		expect(html).toContain('<p class="md-p">');
	});

	it("escapes cell content", () => {
		expect(renderMarkdown("| x |\n|---|\n| <b> |")).not.toContain("<b>");
	});
});

describe("renderMarkdown — headings", () => {
	it("handles every level from one to six", () => {
		for (let n = 1; n <= 6; n += 1) {
			const html = renderMarkdown(`${"#".repeat(n)} T`);
			expect(html).toContain(`<h${n} class="md-h${n}">T</h${n}>`);
		}
	});

	it("does not mistake a seventh hash for a heading", () => {
		expect(renderMarkdown("####### T")).toContain('<p class="md-p">');
	});
});

describe("renderMarkdown — lists", () => {
	it("indents a nested bullet further than its parent", () => {
		const html = renderMarkdown("- one\n  - two\n    - three");
		const pads = [...html.matchAll(/padding-left:([\d.]+)rem/g)].map((m) =>
			Number(m[1]),
		);
		expect(pads).toHaveLength(3);
		expect(pads[0]).toBeLessThan(pads[1]);
		expect(pads[1]).toBeLessThan(pads[2]);
	});

	it("numbers an ordered list from its own value", () => {
		expect(renderMarkdown("3. third")).toContain("3.&nbsp;third");
	});
});

describe("renderMarkdown — code fences", () => {
	it("keeps the fenced content verbatim and records the language", () => {
		const html = renderMarkdown("```python\nx = 1\n# not a heading\n```");
		expect(html).toContain('data-lang="python"');
		expect(html).toContain("# not a heading");
		expect(html).not.toContain("md-h1");
	});

	it("closes an unterminated fence rather than losing it", () => {
		expect(renderMarkdown("```\nkept")).toContain("kept");
	});

	it("does not read a table inside a fence", () => {
		expect(renderMarkdown("```\n| a |\n|---|\n```")).not.toContain("md-table");
	});
});

describe("the repository's own documentation", () => {
	// Ces documents sont ce que le lecteur affiche : s'ils ne rendent pas, la
	// fonctionnalité ne sert à rien.
	const root = resolve(__dirname, "../..");

	it("renders the service reference, tables included", () => {
		const md = readFileSync(resolve(root, "doc/SERVICES.md"), "utf-8");
		const html = renderMarkdown(md);
		expect((html.match(/<table class="md-table">/g) ?? []).length).toBeGreaterThan(10);
		expect(html).not.toContain("|---");
	});

	it("leaves no raw pipe row in the architecture document", () => {
		const md = readFileSync(resolve(root, "doc/ARCHITECTURE.md"), "utf-8");
		const html = renderMarkdown(md);
		expect(html).not.toMatch(/<p class="md-p">\|/);
	});
});
