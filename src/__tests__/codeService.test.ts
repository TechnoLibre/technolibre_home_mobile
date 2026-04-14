import { describe, it, expect } from "vitest";
import { CodeService } from "../services/codeService";

// ── CodeService.isGitUrl ──────────────────────────────────────────────────────

describe("CodeService.isGitUrl", () => {
    it("accepts https:// URLs", () => {
        expect(CodeService.isGitUrl("https://github.com/user/repo.git")).toBe(true);
        expect(CodeService.isGitUrl("https://gitlab.com/org/project")).toBe(true);
    });

    it("accepts http:// URLs", () => {
        expect(CodeService.isGitUrl("http://git.internal/repo.git")).toBe(true);
    });

    it("accepts git@ SSH URLs", () => {
        expect(CodeService.isGitUrl("git@github.com:user/repo.git")).toBe(true);
        expect(CodeService.isGitUrl("git@gitlab.com:org/project.git")).toBe(true);
    });

    it("rejects plain paths", () => {
        expect(CodeService.isGitUrl("/home/user/project")).toBe(false);
        expect(CodeService.isGitUrl("~/code/repo")).toBe(false);
    });

    it("rejects empty string", () => {
        expect(CodeService.isGitUrl("")).toBe(false);
    });

    it("rejects arbitrary strings", () => {
        expect(CodeService.isGitUrl("not-a-url")).toBe(false);
        expect(CodeService.isGitUrl("ftp://files.example.com/repo")).toBe(false);
    });
});

// ── urlToSlug (via reflection — private static) ───────────────────────────────
// We access the private method via a cast to test the slug algorithm, which is
// critical: the UI and the Vite plugin must produce identical slugs so that
// manifest.json entries resolve to the correct /repos/{slug}/ directory.

type CodeServicePrivate = CodeService & {
    _urlToSlug: (url: string) => string;
};
const slug = (url: string) =>
    (CodeService as unknown as { _urlToSlug: (u: string) => string })["_urlToSlug"](url);

describe("CodeService._urlToSlug (must match vite.config.ts urlToSlug)", () => {
    it("strips https:// prefix and converts dots to hyphens", () => {
        // dots are caught by [^a-zA-Z0-9_-] → hyphen, then collapsed
        expect(slug("https://github.com/user/repo")).toBe("github-com-user-repo");
    });

    it("strips .git suffix", () => {
        expect(slug("https://github.com/user/repo.git")).toBe("github-com-user-repo");
    });

    it("converts git@ to slug", () => {
        expect(slug("git@github.com:user/repo.git")).toBe("github-com-user-repo");
    });

    it("replaces slashes, colons and dots with hyphens", () => {
        expect(slug("https://example.com/org/sub/repo")).toBe("example-com-org-sub-repo");
    });

    it("collapses consecutive hyphens", () => {
        const url = "https://github.com/org//repo";
        expect(slug(url)).not.toMatch(/--/);
    });

    it("truncates to 60 characters", () => {
        const long = "https://github.com/" + "a".repeat(80) + "/repo";
        expect(slug(long).length).toBeLessThanOrEqual(60);
    });

    it("only contains alphanumerics, hyphens and underscores", () => {
        const s = slug("https://github.com/user/my-cool_repo.git");
        expect(s).toMatch(/^[a-zA-Z0-9_-]+$/);
    });
});
