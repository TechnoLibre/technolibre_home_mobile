import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyDirToBundle, manifestProjectPathsOnDisk } from "../../vite.config";

// Le bundle de l'espace de travail (section 1b de vite.config.ts) et celui des
// dépôts du manifeste (section 2) ne portent jamais le même fichier : un
// projet du manifeste présent sur le disque hors de addons/ et mobile/, comme
// les jeux du Stream Deck, partirait sinon deux fois dans l'APK.

const MANIFEST =
	'<?xml version="1.0" encoding="UTF-8"?>\n<manifest>\n' +
	'  <remote name="TechnoLibre" fetch="https://github.com/TechnoLibre/"/>\n' +
	'  <project name="streamdeck_game.git" path="script/stream_deck/games"' +
	' remote="TechnoLibre" revision="refs/tags/v1.0.0"/>\n' +
	'  <project name="absent.git" path="script/absent" remote="TechnoLibre"/>\n' +
	"</manifest>\n";

describe("manifest projects and the workspace bundle", () => {
	let ws: string;
	let manifest: string;

	beforeEach(() => {
		ws = mkdtempSync(join(tmpdir(), "bundle-ws-"));
		manifest = join(ws, ".repo/local_manifests/erplibre_manifest.xml");
		mkdirSync(join(ws, ".repo/local_manifests"), { recursive: true });
		writeFileSync(manifest, MANIFEST);
		mkdirSync(join(ws, "script/stream_deck/games/save"), { recursive: true });
		writeFileSync(join(ws, "script/stream_deck/games/game_snake.py"), "");
		// Un voisin dont le nom commence comme le projet : il reste.
		mkdirSync(join(ws, "script/stream_deck/games_extra"), { recursive: true });
		writeFileSync(join(ws, "script/stream_deck/games_contract"), "1.0\n");
		writeFileSync(join(ws, "script/stream_deck/deck_lock.py"), "");
	});

	afterEach(() => rmSync(ws, { recursive: true, force: true }));

	it("names the projects present on disk only", () => {
		expect([...manifestProjectPathsOnDisk(manifest, false)]).toEqual([
			join(ws, "script/stream_deck/games"),
		]);
	});

	it("names nothing when the manifest loop bundles nothing", () => {
		expect(manifestProjectPathsOnDisk(manifest, true).size).toBe(0);
		expect(manifestProjectPathsOnDisk(join(ws, "missing.xml"), false).size).toBe(0);
	});

	it("leaves those projects out of the workspace walk", () => {
		const out = mkdtempSync(join(tmpdir(), "bundle-out-"));
		try {
			const index: { path: string; type: string }[] = [];
			const skip = (_rel: string, name: string) => name === ".repo";
			copyDirToBundle(ws, "", out, index, skip, manifestProjectPathsOnDisk(manifest, false));
			const paths = index.map((e) => e.path);
			expect(paths).toContain("script/stream_deck/games_contract");
			expect(paths).toContain("script/stream_deck/games_extra");
			expect(paths).toContain("script/stream_deck/deck_lock.py");
			expect(paths.filter((p) => p.startsWith("script/stream_deck/games/"))).toEqual([]);
			expect(paths).not.toContain("script/stream_deck/games");
			expect(existsSync(join(out, "script/stream_deck/games"))).toBe(false);
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
	});
});
