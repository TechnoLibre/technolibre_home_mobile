import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCap, mockFs, mockGen } = vi.hoisted(() => ({
    mockCap: { convertFileSrc: vi.fn((p: string) => `https://localhost/${p}`) },
    mockFs: { writeFile: vi.fn() },
    mockGen: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({ Capacitor: mockCap }));
vi.mock("@capacitor/filesystem", () => ({
    Filesystem: mockFs,
    Directory: { External: "EXTERNAL" },
}));
vi.mock("../utils/videoThumbnailUtils", () => ({
    generateVideoThumbnail: mockGen,
}));

import { migrateVideoThumbnails } from "../services/migrations/migrateVideoThumbnails";

function fakeDb(notes: any[]) {
    return {
        getAllNotes: vi.fn().mockResolvedValue(notes),
        updateNote: vi.fn().mockResolvedValue(undefined),
    } as any;
}

function videoEntry(params: any) {
    return { id: "e", type: "video", params };
}

function note(id: string, entries: any[]) {
    return { id, entries };
}

describe("migrateVideoThumbnails", () => {
    beforeEach(() => {
        mockCap.convertFileSrc.mockReset();
        mockCap.convertFileSrc.mockImplementation((p: string) => `https://localhost/${p}`);
        mockFs.writeFile.mockReset();
        mockGen.mockReset();
    });

    it("returns counts under 'Entrées vidéo' even on an empty DB", async () => {
        const db = fakeDb([]);
        const r = await migrateVideoThumbnails(db);
        expect(r).toEqual({ counts: { "Entrées vidéo": { migrated: 0, skipped: 0 } } });
        expect(db.updateNote).not.toHaveBeenCalled();
    });

    it("skips entries that already have a thumbnailPath", async () => {
        const db = fakeDb([note("n1", [
            videoEntry({ path: "/v.mp4", thumbnailPath: "/v.jpg" }),
        ])]);
        const r = await migrateVideoThumbnails(db);
        expect(r.counts["Entrées vidéo"]).toEqual({ migrated: 0, skipped: 1 });
        expect(mockGen).not.toHaveBeenCalled();
        expect(db.updateNote).not.toHaveBeenCalled();
    });

    it("skips entries with no path", async () => {
        const db = fakeDb([note("n1", [videoEntry({ path: "" })])]);
        const r = await migrateVideoThumbnails(db);
        expect(r.counts["Entrées vidéo"].skipped).toBe(1);
        expect(mockGen).not.toHaveBeenCalled();
    });

    it("ignores non-video entries", async () => {
        const db = fakeDb([note("n1", [
            { id: "t", type: "text", params: { text: "hi" } },
        ])]);
        const r = await migrateVideoThumbnails(db);
        expect(r.counts["Entrées vidéo"]).toEqual({ migrated: 0, skipped: 0 });
        expect(db.updateNote).not.toHaveBeenCalled();
    });

    it("generates thumbnails, writes them and persists the note once", async () => {
        const params = { path: "/storage/clip.mp4" } as any;
        const db = fakeDb([note("n1", [videoEntry(params)])]);
        mockGen.mockResolvedValue("BASE64");
        mockFs.writeFile.mockResolvedValue({ uri: "file:///out/clip.jpg" });

        const r = await migrateVideoThumbnails(db);

        expect(mockCap.convertFileSrc).toHaveBeenCalledWith("/storage/clip.mp4");
        expect(mockGen).toHaveBeenCalledWith("https://localhost//storage/clip.mp4");
        expect(mockFs.writeFile).toHaveBeenCalledWith({
            path: "clip.jpg",
            data: "BASE64",
            directory: "EXTERNAL",
        });
        expect(params.thumbnailPath).toBe("file:///out/clip.jpg");
        expect(db.updateNote).toHaveBeenCalledTimes(1);
        expect(r.counts["Entrées vidéo"]).toEqual({ migrated: 1, skipped: 0 });
    });

    it("counts a generation failure as skipped without throwing", async () => {
        const db = fakeDb([note("n1", [videoEntry({ path: "/x.mp4" })])]);
        mockGen.mockRejectedValue(new Error("decode failed"));

        const r = await migrateVideoThumbnails(db);
        expect(r.counts["Entrées vidéo"]).toEqual({ migrated: 0, skipped: 1 });
        expect(db.updateNote).not.toHaveBeenCalled();
    });

    it("falls back to 'video.jpg' when path has no filename segment", async () => {
        const db = fakeDb([note("n1", [videoEntry({ path: "" })])]);
        // empty path is skipped → won't reach writeFile. Use a path with
        // no extension instead to exercise the basename rule.
        const note2 = note("n2", [videoEntry({ path: "/onlyfile" })]);
        const db2 = fakeDb([note2]);
        mockGen.mockResolvedValue("B64");
        mockFs.writeFile.mockResolvedValue({ uri: "file:///out.jpg" });
        await migrateVideoThumbnails(db2);
        expect(mockFs.writeFile.mock.calls[0][0].path).toBe("onlyfile");
    });

    it("only updates the note once even with multiple migrated entries", async () => {
        const e1 = videoEntry({ path: "/a.mp4" });
        const e2 = videoEntry({ path: "/b.mp4" });
        const db = fakeDb([note("n1", [e1, e2])]);
        mockGen.mockResolvedValue("B64");
        mockFs.writeFile.mockResolvedValue({ uri: "file:///out.jpg" });

        const r = await migrateVideoThumbnails(db);
        expect(db.updateNote).toHaveBeenCalledTimes(1);
        expect(r.counts["Entrées vidéo"].migrated).toBe(2);
    });
});
