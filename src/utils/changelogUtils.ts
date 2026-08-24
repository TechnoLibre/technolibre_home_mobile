/**
 * Reading of the Keep-a-Changelog document shipped in the bundle.
 *
 * The app used to carry its own copy of the changelog as a string literal,
 * which is how it came to advertise a version five months old. CHANGELOG.md
 * is already copied into the bundle by `bundleSourcePlugin`, so it is the one
 * source of truth and nothing here needs bumping at release time.
 *
 * Every function is pure — the fetch lives in the component.
 */

export interface ChangelogRelease {
	/** The bracketed heading text: a dotted version, or "Unreleased". */
	version: string;
	/** The ISO date after the dash, when the heading carries one. */
	date: string | null;
	/** Everything between this heading and the next, trimmed. */
	body: string;
}

/** `## [2026.08.24.01] - 2026-08-24` — the date half is optional. */
const HEADING = /^##\s+\[([^\]]+)\]\s*(?:-\s*(\S+))?\s*$/;

/** A dotted numeric version. Excludes "Unreleased" and any other placeholder. */
const RELEASED = /^\d+(?:\.\d+)+$/;

export function parseChangelog(markdown: string): ChangelogRelease[] {
	const releases: ChangelogRelease[] = [];
	let current: ChangelogRelease | null = null;

	for (const line of markdown.split("\n")) {
		const heading = HEADING.exec(line);
		if (heading) {
			if (current) releases.push(current);
			current = { version: heading[1], date: heading[2] ?? null, body: "" };
			continue;
		}
		// Lines before the first heading are the document preamble; drop them.
		if (current) current.body += current.body === "" ? line : `\n${line}`;
	}
	if (current) releases.push(current);

	return releases.map((r) => ({ ...r, body: r.body.trim() }));
}

/** The newest released version, skipping "Unreleased". `null` when there is none. */
export function latestVersion(releases: ChangelogRelease[]): string | null {
	return releases.find((r) => RELEASED.test(r.version))?.version ?? null;
}

/**
 * Flatten markdown into what a native alert can actually render: no `###`,
 * no `**`, no backticks. Bullets and indentation are kept.
 */
export function toPlainText(body: string): string {
	return body
		.split("\n")
		.map((line) =>
			line
				.replace(/^(\s*)#{2,}\s*(.+?)\s*$/, "$1$2:")
				.replace(/\*\*(.+?)\*\*/g, "$1")
				.replace(/`([^`]+)`/g, "$1"),
		)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * The dialog body: the `limit` most recent releases that carry content.
 * An empty section — a freshly opened "Unreleased" — is skipped rather than
 * rendered as a bare heading.
 */
export function formatReleases(releases: ChangelogRelease[], limit = 3): string {
	return releases
		.filter((r) => RELEASED.test(r.version) && r.body !== "")
		.slice(0, limit)
		.map((r) => `=== ${r.version} ===\n${toPlainText(r.body)}`)
		.join("\n\n");
}
