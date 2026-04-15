import { describe, it, expect } from "vitest";
import { buildViewPath } from "../utils/debugUtils";

describe("buildViewPath", () => {
	it("returns title alone when breadcrumbs are empty", () => {
		expect(buildViewPath([], "Notes")).toBe("Notes");
	});

	it("prepends single breadcrumb label", () => {
		expect(buildViewPath([{ label: "Options" }], "Transcription")).toBe(
			"Options › Transcription",
		);
	});

	it("joins multiple breadcrumb labels with title", () => {
		expect(
			buildViewPath(
				[{ label: "Accueil" }, { label: "Options" }],
				"Transcription",
			),
		).toBe("Accueil › Options › Transcription");
	});

	it("uses › separator between all segments", () => {
		const result = buildViewPath([{ label: "A" }, { label: "B" }], "C");
		expect(result.split(" › ")).toEqual(["A", "B", "C"]);
	});
});
