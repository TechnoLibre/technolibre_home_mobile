/**
 * Reconstructs a human-readable view path from breadcrumbs and a page title.
 * Used by the debug ⋮ menu to identify the current screen for Claude Code.
 *
 * Examples:
 *   buildViewPath([{label:"Options"}], "Transcription") → "Options › Transcription"
 *   buildViewPath([], "Notes")                          → "Notes"
 */
export function buildViewPath(
	breadcrumbs: Array<{ label: string }>,
	title: string,
): string {
	return breadcrumbs.length
		? [...breadcrumbs.map((c) => c.label), title].join(" › ")
		: title;
}
