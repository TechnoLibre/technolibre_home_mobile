import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFs, mockGit } = vi.hoisted(() => ({
    mockFs: {
        readFile: vi.fn(), writeFile: vi.fn(), readdir: vi.fn(),
        deleteFile: vi.fn(), mkdir: vi.fn(),
    },
    mockGit: {
        statusMatrix: vi.fn(),
        commit: vi.fn(),
        log: vi.fn(),
        checkout: vi.fn(),
        add: vi.fn(),
        readBlob: vi.fn(),
        resolveRef: vi.fn(),
    },
}));

vi.mock("@capacitor/filesystem", () => ({
    Filesystem: mockFs,
    Directory: { Cache: "CACHE", Data: "DATA" },
}));

vi.mock("isomorphic-git", () => mockGit);

import { EditableCodeService } from "../services/editableCodeService";

describe("EditableCodeService", () => {
    beforeEach(() => {
        Object.values(mockFs).forEach((f) => f.mockReset());
        Object.values(mockGit).forEach((f) => f.mockReset());
    });

    it("writeFile persists to Documents", async () => {
        mockFs.writeFile.mockResolvedValue(undefined);
        const svc = new EditableCodeService("foo");
        await svc.writeFile("README.md", "# updated");
        expect(mockFs.writeFile).toHaveBeenCalledWith(expect.objectContaining({
            path: "repos/foo/README.md",
            directory: "DATA",
        }));
    });

    it("status returns parsed matrix from isomorphic-git", async () => {
        mockGit.statusMatrix.mockResolvedValue([
            ["README.md", 1, 2, 1],   // modified, unstaged
            ["new.txt",   0, 2, 0],   // untracked
            ["staged.md", 1, 2, 2],   // staged-modified
            ["gone.md",   1, 0, 0],   // deleted
        ]);
        const svc = new EditableCodeService("foo");
        const s = await svc.status();
        expect(s.modified).toContain("README.md");
        expect(s.untracked).toContain("new.txt");
        expect(s.staged).toContain("staged.md");
        expect(s.deleted).toContain("gone.md");
    });

    it("commit returns SHA", async () => {
        mockGit.add.mockResolvedValue(undefined);
        mockGit.commit.mockResolvedValue("abc123");
        const svc = new EditableCodeService("foo");
        const sha = await svc.commit("change x");
        expect(sha).toBe("abc123");
    });

    it("listDir filters .git out", async () => {
        mockFs.readdir.mockResolvedValue({
            files: [
                { name: ".git", type: "directory" },
                { name: "README.md", type: "file" },
                { name: "src", type: "directory" },
            ],
        });
        const svc = new EditableCodeService("foo");
        const entries = await svc.listDir("");
        expect(entries.map((e) => e.name)).toEqual(["README.md", "src"]);
    });

    it("readFile decodes base64 to UTF-8", async () => {
        // base64 "aGVsbG8=" = "hello"
        mockFs.readFile.mockResolvedValue({ data: "aGVsbG8=" });
        const svc = new EditableCodeService("foo");
        const content = await svc.readFile("README.md");
        expect(content).toBe("hello");
    });
});
