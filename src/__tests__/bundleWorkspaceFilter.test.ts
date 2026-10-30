import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bundleWorkspace, copyDirToBundle, gitTrackedPaths, workspaceSkip } from "../../vite.config";

// Le bundle de l'espace de travail (section 1b de vite.config.ts) part dans
// l'APK : seuls les fichiers que git suit y vont. Les notes d'enquête
// (tasks/, .superpowers/), une configuration locale ignorée ou un fichier
// pas encore ajouté restent sur le poste. Sans git pour dire ce qu'il suit,
// rien n'y va.

const write = (root: string, rel: string, text = "") => {
	mkdirSync(join(root, rel, ".."), { recursive: true });
	writeFileSync(join(root, rel), text);
};

const bundled = (ws: string, skip: (relBase: string, name: string) => boolean): string[] => {
	const out = mkdtempSync(join(tmpdir(), "bundle-out-"));
	try {
		const index: { path: string; type: string }[] = [];
		copyDirToBundle(ws, "", out, index, skip);
		return index.map((e) => e.path);
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
};

describe("the workspace bundle", () => {
	let ws: string;

	beforeEach(() => {
		ws = mkdtempSync(join(tmpdir(), "bundle-ws-"));
		write(ws, ".gitignore", "/tasks/\n/.superpowers/\nconfig.conf\n");
		write(ws, "script/outil.py", "print('ok')\n");
		write(ws, "doc/tasks/guide.md", "# Guide\n");
		write(ws, "private/TODO.md", "à faire\n");
		write(ws, "tasks/chat/ledger.md", "notes d'enquête\n");
		write(ws, ".superpowers/sdd/rapport.md", "rapport\n");
		write(ws, "config.conf", "admin_passwd = exemple\n");
		write(ws, "brouillon.txt", "pas encore ajouté\n");
	});

	afterEach(() => rmSync(ws, { recursive: true, force: true }));

	it("carries only the files git tracks", () => {
		execFileSync("git", ["init", "-q", ws]);
		execFileSync("git", ["-C", ws, "add", ".gitignore", "script/outil.py", "doc/tasks/guide.md", "private/TODO.md"]);
		const paths = bundled(ws, workspaceSkip(gitTrackedPaths(ws)));
		expect(paths).toContain("script/outil.py");
		expect(paths).toContain("doc/tasks/guide.md");
		expect(paths).toContain(".gitignore");
		for (const p of ["tasks", ".superpowers", "config.conf", "brouillon.txt", "private"]) {
			expect(paths.filter((q) => q === p || q.startsWith(p + "/"))).toEqual([]);
		}
	});

	it("bundles nothing where git cannot list what it tracks", () => {
		expect(gitTrackedPaths(ws)).toBeNull();
		const out = join(mkdtempSync(join(tmpdir(), "bundle-out-")), "erplibre");
		mkdirSync(out);
		write(out, "tasks/ancien.md", "copie d'un build d'avant\n");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(bundleWorkspace(ws, out, new Set())).toBeNull();
			expect(existsSync(out)).toBe(false);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("src/public/erplibre"));
		} finally {
			warn.mockRestore();
			rmSync(join(out, ".."), { recursive: true, force: true });
		}
	});

	it("bundles the tracked files into the output with their index", () => {
		execFileSync("git", ["init", "-q", ws]);
		execFileSync("git", ["-C", ws, "add", ".gitignore", "script/outil.py"]);
		const out = join(mkdtempSync(join(tmpdir(), "bundle-out-")), "erplibre");
		try {
			expect(bundleWorkspace(ws, out, new Set())?.copied).toBe(2);
			expect(existsSync(join(out, "script/outil.py"))).toBe(true);
			expect(existsSync(join(out, "config.conf"))).toBe(false);
			expect(existsSync(join(out, "index.json"))).toBe(true);
		} finally {
			rmSync(join(out, ".."), { recursive: true, force: true });
		}
	});
});

describe("copyDirToBundle", () => {
	it("skips a broken link with a debug line, not a warning", () => {
		const src = mkdtempSync(join(tmpdir(), "bundle-src-"));
		const out = mkdtempSync(join(tmpdir(), "bundle-out-"));
		write(src, "module/__init__.py", "");
		symlinkSync(join(src, "absent"), join(src, "module", "lien"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const index: { path: string; type: string }[] = [];
			const stats = { copied: 0, skippedName: 0, skippedExclude: 0, skippedSize: 0, skippedLink: 0, errors: 0 };
			copyDirToBundle(src, "", out, index, undefined, undefined, undefined, stats);
			expect(index.map((e) => e.path).sort()).toEqual(["module", "module/__init__.py"]);
			expect(stats).toMatchObject({ copied: 1, skippedLink: 1, errors: 0 });
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
			rmSync(src, { recursive: true, force: true });
			rmSync(out, { recursive: true, force: true });
		}
	});
});
