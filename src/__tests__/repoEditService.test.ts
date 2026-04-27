import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFs, mockGit, mockFetch } = vi.hoisted(() => ({
    mockFs: {
        readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(),
        readdir: vi.fn(), stat: vi.fn(), rmdir: vi.fn(),
    },
    mockGit: {
        init: vi.fn(),
        add: vi.fn(),
        commit: vi.fn(),
    },
    mockFetch: vi.fn(),
}));

vi.mock("@capacitor/filesystem", () => ({
    Filesystem: mockFs,
    Directory: { Cache: "CACHE", Data: "DATA" },
}));

vi.mock("isomorphic-git", () => mockGit);

global.fetch = mockFetch as unknown as typeof fetch;

import { RepoEditService } from "../services/repoEditService";
import { RepoExtractorService } from "../services/repoExtractorService";

describe("RepoEditService", () => {
    beforeEach(() => {
        Object.values(mockFs).forEach((f) => f.mockReset());
        Object.values(mockGit).forEach((f) => f.mockReset());
        mockFetch.mockReset();
    });

    it("promoteToEditable copies Cache → Documents, runs git init+add+commit, persists row", async () => {
        const extractor = {
            ensureExtracted: vi.fn().mockResolvedValue("repos/foo"),
        } as unknown as RepoExtractorService;

        // listing under Cache/repos/foo
        mockFs.readdir
            .mockResolvedValueOnce({
                files: [{ name: "README.md", type: "file" }, { name: "src", type: "directory" }],
            })
            .mockResolvedValueOnce({
                files: [{ name: "main.py", type: "file" }],
            });
        mockFs.readFile.mockResolvedValue({ data: "aGk=" });
        mockFs.writeFile.mockResolvedValue(undefined);
        mockFs.mkdir.mockResolvedValue(undefined);
        mockGit.init.mockResolvedValue(undefined);
        mockGit.add.mockResolvedValue(undefined);
        mockGit.commit.mockResolvedValue("baseline-sha");
        mockFetch.mockResolvedValue(new Response(JSON.stringify({ buildId: "build123" })));

        const db = {
            run: vi.fn().mockResolvedValue(undefined),
            all: vi.fn().mockResolvedValue([]),
        };
        const svc = new RepoEditService(extractor, db);
        const sha = await svc.promoteToEditable("foo", "/repos/foo.tar.gz");

        expect(extractor.ensureExtracted).toHaveBeenCalled();
        expect(mockGit.init).toHaveBeenCalledWith(expect.objectContaining({
            dir: "/repos/foo",
        }));
        expect(mockGit.add).toHaveBeenCalled();
        expect(mockGit.commit).toHaveBeenCalled();
        expect(sha).toBe("baseline-sha");
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining("INSERT"),
            expect.arrayContaining(["foo", "baseline-sha", "build123"]),
        );
    });

    it("promoteToEditable is idempotent (returns existing baseline)", async () => {
        const db = {
            run: vi.fn(),
            all: vi.fn()
                .mockResolvedValueOnce([{ slug: "foo" }])             // isEditable check
                .mockResolvedValueOnce([{ baseline_sha: "old-sha" }]), // baseline lookup
        };
        const extractor = { ensureExtracted: vi.fn() } as unknown as RepoExtractorService;
        const svc = new RepoEditService(extractor, db);
        const sha = await svc.promoteToEditable("foo");
        expect(sha).toBe("old-sha");
        expect(extractor.ensureExtracted).not.toHaveBeenCalled();
        expect(mockGit.init).not.toHaveBeenCalled();
    });

    it("unpromote removes Documents copy and SQLite row", async () => {
        const db = {
            run: vi.fn().mockResolvedValue(undefined),
            all: vi.fn().mockResolvedValueOnce([{ slug: "foo" }]),
        };
        mockFs.rmdir.mockResolvedValue(undefined);
        const extractor = { ensureExtracted: vi.fn() } as unknown as RepoExtractorService;
        const svc = new RepoEditService(extractor, db);
        await svc.unpromote("foo");
        expect(mockFs.rmdir).toHaveBeenCalledWith(expect.objectContaining({
            path: "repos/foo",
            directory: "DATA",
        }));
        expect(db.run).toHaveBeenCalledWith(expect.stringContaining("DELETE"), ["foo"]);
    });
});
