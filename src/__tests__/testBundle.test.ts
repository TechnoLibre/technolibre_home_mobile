import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BUNDLE = join(ROOT, "test-bundle");

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else out.push(p.slice(BUNDLE.length + 1));
	}
	return out;
}

describe("test bundle", () => {
	const files = walk(BUNDLE);

	it("exists and is not empty", () => {
		expect(files.length).toBeGreaterThan(40);
	});

	// Il sert à éprouver l'affichage : un format qui disparaît du jeu cesse
	// d'être testé sans que rien ne le dise.
	it("covers every display format it is there for", () => {
		const exts = new Set(files.map((f) => f.slice(f.lastIndexOf("."))));
		for (const ext of [
			".png", ".gif", ".bmp", ".svg", ".jpg", ".jpeg", ".webp",
			".wav", ".mp3", ".ogg", ".ico",
			".md", ".json", ".csv", ".xml", ".yaml", ".toml", ".txt",
		]) {
			expect(exts, `format absent : ${ext}`).toContain(ext);
		}
	});

	it("covers the six code projects", () => {
		for (const p of [
			"code/python-tornado", "code/python-owl", "code/javascript",
			"code/rust", "code/cpp", "code/java",
		]) {
			expect(existsSync(join(BUNDLE, p)), `projet absent : ${p}`).toBe(true);
		}
	});

	// Le jeu est copié entier dans l'APK : il doit rester une fixture, pas une
	// charge. La mesure au moment de l'écriture était de 368 Ko.
	it("stays light enough to ship", () => {
		const total = files.reduce(
			(n, f) => n + statSync(join(BUNDLE, f)).size,
			0,
		);
		expect(total).toBeLessThan(600 * 1024);
	});

	it("keeps no file big on its own", () => {
		const big = files.filter(
			(f) => statSync(join(BUNDLE, f)).size > 64 * 1024,
		);
		expect(big).toEqual([]);
	});

	it("records where every borrowed file came from", () => {
		const prov = readFileSync(join(BUNDLE, "media/PROVENANCE.md"), "utf-8");
		for (const f of ["photo.jpg", "icon.webp", "sound.mp3", "sound.ogg", "favicon.ico"]) {
			expect(prov, `provenance manquante : ${f}`).toContain(f);
		}
	});

	// La vidéo manque faute d'encodeur. Le jour où elle arrive, ce test tombe
	// et rappelle de retirer la note qui dit qu'elle manque.
	it("says so as long as no video ships", () => {
		const hasVideo = files.some((f) => /\.(mp4|webm|mov)$/.test(f));
		const readme = readFileSync(join(BUNDLE, "README.md"), "utf-8");
		if (hasVideo) {
			expect(readme).not.toContain("Ce qui manque");
		} else {
			expect(readme).toContain("Ce qui manque");
		}
	});
});
