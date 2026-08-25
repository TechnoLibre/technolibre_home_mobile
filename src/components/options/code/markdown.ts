/**
 * Rendu Markdown du lecteur de code : assez pour lire la documentation du
 * dépôt, pas une implémentation de CommonMark.
 *
 * Les TABLEAUX étaient le manque qui comptait : chaque document de doc/ en est
 * fait, et sans eux le lecteur affichait des rangées de barres verticales comme
 * autant de paragraphes.
 *
 * Aucune dépendance : le HTML produit est déjà échappé, et les classes `md-*`
 * sont stylées dans options_code_component.scss.
 */

export function escHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function applyInline(s: string): string {
	return s
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/\*(.+?)\*/g, "<em>$1</em>")
		.replace(/`(.+?)`/g, '<code class="md-inline-code">$1</code>')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '<span class="md-link">$1</span>');
}

/** `| a | b |` — une rangée, barres de bord facultatives. */
function splitRow(line: string): string[] {
	let s = line.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|")) s = s.slice(0, -1);
	return s.split("|").map((c) => c.trim());
}

/** `|---|:--:|---:|` — la rangée qui fait d'un tableau un tableau. */
function alignments(line: string): string[] | null {
	const cells = splitRow(line);
	if (cells.length === 0) return null;
	const out: string[] = [];
	for (const c of cells) {
		if (!/^:?-{1,}:?$/.test(c)) return null;
		if (c.startsWith(":") && c.endsWith(":")) out.push("center");
		else if (c.endsWith(":")) out.push("right");
		else out.push("left");
	}
	return out;
}

function renderTable(head: string[], align: string[], body: string[][]): string {
	const cell = (tag: string, text: string, i: number) => {
		const a = align[i] ?? "left";
		return `<${tag} class="md-td md-td--${a}">${applyInline(escHtml(text))}</${tag}>`;
	};
	const rows = body
		.map(
			(r) =>
				"<tr>" +
				head.map((_, i) => cell("td", r[i] ?? "", i)).join("") +
				"</tr>",
		)
		.join("");
	return (
		'<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
		head.map((h, i) => cell("th", h, i)).join("") +
		`</tr></thead><tbody>${rows}</tbody></table></div>`
	);
}

/** Profondeur d'imbrication d'une puce, deux espaces par niveau. */
function bulletDepth(raw: string): number {
	const lead = raw.match(/^([ \t]*)/)?.[1] ?? "";
	return Math.floor(lead.replace(/\t/g, "  ").length / 2);
}

const HEADINGS: Array<[string, number]> = [
	["###### ", 6],
	["##### ", 5],
	["#### ", 4],
	["### ", 3],
	["## ", 2],
	["# ", 1],
];

export function renderMarkdown(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let inCode = false;
	let codeLines: string[] = [];
	let codeLang = "";

	for (let i = 0; i < lines.length; i += 1) {
		const raw = lines[i];

		if (raw.startsWith("```")) {
			if (inCode) {
				out.push(
					`<pre class="md-code-block" data-lang="${escHtml(codeLang)}">` +
						`<code>${escHtml(codeLines.join("\n"))}</code></pre>`,
				);
				codeLines = [];
				codeLang = "";
				inCode = false;
			} else {
				codeLang = raw.slice(3).trim();
				inCode = true;
			}
			continue;
		}
		if (inCode) {
			codeLines.push(raw);
			continue;
		}

		// Tableau : une rangée, puis la rangée d'alignement. Sans la seconde,
		// la première n'est qu'un paragraphe qui contient des barres.
		const trimmed = raw.trim();
		if (trimmed.includes("|") && i + 1 < lines.length) {
			const align = alignments(lines[i + 1]);
			const head = splitRow(raw);
			if (align && align.length === head.length && head.length > 1) {
				const body: string[][] = [];
				let j = i + 2;
				while (j < lines.length && lines[j].trim().includes("|")) {
					body.push(splitRow(lines[j]));
					j += 1;
				}
				out.push(renderTable(head, align, body));
				i = j - 1;
				continue;
			}
		}

		const l = escHtml(raw);
		const heading = HEADINGS.find(([p]) => l.startsWith(p));
		if (heading) {
			const [prefix, level] = heading;
			out.push(
				`<h${level} class="md-h${level}">` +
					`${applyInline(l.slice(prefix.length))}</h${level}>`,
			);
			continue;
		}
		const bare = l.trim();
		if (bare === "---" || bare === "***" || bare === "___") {
			out.push('<hr class="md-hr" />');
		} else if (/^[-*] /.test(bare)) {
			const depth = bulletDepth(raw);
			out.push(
				`<div class="md-li" style="padding-left:${0.3 + depth * 1.1}rem">` +
					`•&nbsp;${applyInline(bare.slice(2))}</div>`,
			);
		} else if (/^\d+\. /.test(bare)) {
			const m = bare.match(/^(\d+)\. (.*)/);
			const depth = bulletDepth(raw);
			if (m) {
				out.push(
					`<div class="md-li" style="padding-left:${0.3 + depth * 1.1}rem">` +
						`${m[1]}.&nbsp;${applyInline(m[2])}</div>`,
				);
			}
		} else if (bare.startsWith("&gt; ")) {
			out.push(
				`<blockquote class="md-blockquote">` +
					`${applyInline(bare.slice(5))}</blockquote>`,
			);
		} else if (bare === "") {
			out.push('<div class="md-spacer"></div>');
		} else {
			out.push(`<p class="md-p">${applyInline(l)}</p>`);
		}
	}
	if (inCode && codeLines.length > 0) {
		out.push(
			`<pre class="md-code-block"><code>` +
				`${escHtml(codeLines.join("\n"))}</code></pre>`,
		);
	}
	return out.join("");
}
