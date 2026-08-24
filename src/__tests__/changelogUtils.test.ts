import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
	parseChangelog,
	latestVersion,
	toPlainText,
	formatReleases,
} from "../utils/changelogUtils";

const SAMPLE = `# Changelog

Preamble that belongs to no release.

## [Unreleased]

## [2026.08.24.01] - 2026-08-24

Summary line.

### Added
- **Thing** — with \`code\` in it

## [2025.12.28.01] - 2025-12-28

### Added
- Older thing
`;

describe("parseChangelog", () => {
	it("splits on H2 headings and drops the preamble", () => {
		const r = parseChangelog(SAMPLE);
		expect(r.map((x) => x.version)).toEqual([
			"Unreleased",
			"2026.08.24.01",
			"2025.12.28.01",
		]);
		expect(r[0].body).toBe("");
		expect(r[1].body).toContain("Summary line.");
		expect(r[1].body).not.toContain("Preamble");
	});

	it("reads the date when the heading carries one", () => {
		const r = parseChangelog(SAMPLE);
		expect(r[0].date).toBeNull();
		expect(r[1].date).toBe("2026-08-24");
	});

	it("returns nothing for a document with no release heading", () => {
		expect(parseChangelog("# Title\n\nJust prose.\n")).toEqual([]);
	});
});

describe("latestVersion", () => {
	it("skips Unreleased and returns the newest dotted version", () => {
		expect(latestVersion(parseChangelog(SAMPLE))).toBe("2026.08.24.01");
	});

	it("returns null when nothing has been released", () => {
		expect(latestVersion(parseChangelog("## [Unreleased]\n"))).toBeNull();
	});
});

describe("toPlainText", () => {
	it("turns headings into labels and strips bold and code marks", () => {
		expect(toPlainText("### Added\n- **Thing** — with `code`")).toBe(
			"Added:\n- Thing — with code",
		);
	});

	it("collapses runs of blank lines", () => {
		expect(toPlainText("a\n\n\n\nb")).toBe("a\n\nb");
	});

	it("keeps the indentation of nested bullets", () => {
		expect(toPlainText("- one\n  - two")).toBe("- one\n  - two");
	});
});

describe("formatReleases", () => {
	it("skips an empty Unreleased section", () => {
		expect(formatReleases(parseChangelog(SAMPLE))).not.toContain("Unreleased");
	});

	it("honours the limit, newest first", () => {
		const out = formatReleases(parseChangelog(SAMPLE), 1);
		expect(out).toContain("=== 2026.08.24.01 ===");
		expect(out).not.toContain("2025.12.28.01");
	});
});

describe("the repository's own CHANGELOG.md", () => {
	// The component reads this very file from the bundle, so a heading format
	// the parser cannot read would leave the version blank in the app.
	const md = readFileSync(resolve(__dirname, "../../CHANGELOG.md"), "utf-8");

	it("parses, and its newest release matches the first dated heading", () => {
		const releases = parseChangelog(md);
		expect(releases.length).toBeGreaterThan(1);
		const firstDated = /^## \[(\d[\d.]*)\]/m.exec(md);
		expect(latestVersion(releases)).toBe(firstDated?.[1]);
	});

	it("produces a non-empty dialog body", () => {
		expect(formatReleases(parseChangelog(md)).length).toBeGreaterThan(100);
	});
});
