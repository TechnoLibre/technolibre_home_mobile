import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFs } = vi.hoisted(() => ({
    mockFs: {
        writeFile: vi.fn(), appendFile: vi.fn(), stat: vi.fn(), getUri: vi.fn(),
        rename: vi.fn(), deleteFile: vi.fn(), rmdir: vi.fn(), copy: vi.fn(), mkdir: vi.fn(),
    },
}));

vi.mock("@capacitor/filesystem", () => ({
    Filesystem: mockFs,
    Directory: { Data: "DATA" },
}));

import {
    WRITE_CHUNK_BYTES, deviceChatFiles, originalPath, outgoingPath, previewPath, safeFileName, sourceDir,
} from "../services/chat/chatFiles";
import { memoryChatFiles } from "../testing/chatFakes";

function base64Bytes(b64: string): number[] {
    return Array.from(atob(b64), (c) => c.charCodeAt(0));
}

describe("safeFileName", () => {
    it("keeps an ordinary name", () => {
        expect(safeFileName("Photo 2026-10-26.jpg")).toBe("Photo 2026-10-26.jpg");
        expect(safeFileName("résumé été.pdf")).toBe("résumé été.pdf");
    });

    it("replaces separators and drops control characters", () => {
        expect(safeFileName("a/b\\c.txt")).toBe("a_b_c.txt");
        expect(safeFileName("bad\u0000na\u001fme\u007f.txt")).toBe("badname.txt");
        expect(safeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
    });

    it("never starts with a dot and is never empty", () => {
        expect(safeFileName(".hidden")).toBe("hidden");
        expect(safeFileName("...")).toBe("file");
        expect(safeFileName("")).toBe("file");
        expect(safeFileName("  ")).toBe("file");
    });

    it("cuts a long name to 120 characters, extension kept", () => {
        const name = safeFileName("x".repeat(300) + ".pdf");
        expect(name).toHaveLength(120);
        expect(name.endsWith(".pdf")).toBe(true);
        const wide = safeFileName("文".repeat(200) + ".docx");
        expect(Array.from(wide).length).toBeLessThanOrEqual(120);
        expect(new TextEncoder().encode(wide).length).toBeLessThanOrEqual(240);
        expect(wide.endsWith(".docx")).toBe(true);
    });
});

describe("chat file layout", () => {
    it("places every file under chat/<fileDir>", () => {
        expect(sourceDir("k3x9")).toBe("chat/k3x9");
        expect(outgoingPath("k3x9", "5d0c-11", "a/b.jpg")).toBe("chat/k3x9/out/5d0c-11/a_b.jpg");
        expect(originalPath("k3x9", 42, "report.pdf")).toBe("chat/k3x9/files/42/report.pdf");
        expect(previewPath("k3x9", 42)).toBe("chat/k3x9/thumbs/42");
    });

    it("refuses a segment that could leave the directory", () => {
        expect(() => sourceDir("../x")).toThrow();
        expect(() => outgoingPath("k", "a/../b", "n")).toThrow();
        expect(() => originalPath("k", 0, "n")).toThrow();
        expect(() => previewPath("k", -3)).toThrow();
    });
});

describe("deviceChatFiles", () => {
    beforeEach(() => Object.values(mockFs).forEach((f) => f.mockReset().mockResolvedValue(undefined)));

    it("writeBlob writes 3 chunks for a 2 MiB blob, the first creating the file", async () => {
        const bytes = new Uint8Array(2 * 1024 * 1024);
        for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
        const size = await deviceChatFiles.writeBlob("chat/d/out/u/a.bin", new Blob([bytes]));
        expect(size).toBe(bytes.length);
        expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
        expect(mockFs.appendFile).toHaveBeenCalledTimes(2);
        const first = mockFs.writeFile.mock.calls[0][0];
        expect(first).toMatchObject({ path: "chat/d/out/u/a.bin", directory: "DATA", recursive: true });
        const chunks = [first, ...mockFs.appendFile.mock.calls.map((c) => c[0])];
        expect(chunks.map((c) => base64Bytes(c.data).length))
            .toEqual([WRITE_CHUNK_BYTES, WRITE_CHUNK_BYTES, bytes.length - 2 * WRITE_CHUNK_BYTES]);
        const joined = chunks.flatMap((c) => base64Bytes(c.data));
        expect(joined.slice(0, 16)).toEqual(Array.from(bytes.slice(0, 16)));
        expect(joined.slice(-16)).toEqual(Array.from(bytes.slice(-16)));
    });

    it("writeBlob creates an empty file for an empty blob", async () => {
        expect(await deviceChatFiles.writeBlob("chat/d/out/u/e", new Blob([]))).toBe(0);
        expect(mockFs.writeFile).toHaveBeenCalledWith(expect.objectContaining({ data: "" }));
        expect(mockFs.appendFile).not.toHaveBeenCalled();
    });

    it("size is null for a missing file", async () => {
        mockFs.stat.mockResolvedValueOnce({ size: 12 }).mockRejectedValueOnce(new Error("does not exist"));
        expect(await deviceChatFiles.size("chat/d/a")).toBe(12);
        expect(await deviceChatFiles.size("chat/d/b")).toBeNull();
    });

    it("uri and webUrl resolve under Directory.Data", async () => {
        mockFs.getUri.mockResolvedValue({ uri: "file:///data/files/chat/d/a.png" });
        expect(await deviceChatFiles.uri("chat/d/a.png")).toBe("file:///data/files/chat/d/a.png");
        expect(mockFs.getUri).toHaveBeenCalledWith({ path: "chat/d/a.png", directory: "DATA" });
        expect(await deviceChatFiles.webUrl("chat/d/a.png")).toBe("file:///data/files/chat/d/a.png");
    });

    it("copyFrom copies an outside uri in and returns its size", async () => {
        mockFs.stat.mockResolvedValue({ size: 99 });
        expect(await deviceChatFiles.copyFrom("file:///cache/photo.jpg", "chat/d/out/u/photo.jpg")).toBe(99);
        expect(mockFs.copy).toHaveBeenCalledWith({
            from: "file:///cache/photo.jpg", to: "chat/d/out/u/photo.jpg", toDirectory: "DATA",
        });
    });

    it("rename makes the target directory, remove and removeDir ignore a missing path", async () => {
        await deviceChatFiles.rename("chat/d/out/u/a.jpg", "chat/d/files/9/a.jpg");
        expect(mockFs.mkdir).toHaveBeenCalledWith({ path: "chat/d/files/9", directory: "DATA", recursive: true });
        expect(mockFs.rename).toHaveBeenCalledWith({
            from: "chat/d/out/u/a.jpg", to: "chat/d/files/9/a.jpg", directory: "DATA", toDirectory: "DATA",
        });
        mockFs.deleteFile.mockRejectedValue(new Error("File does not exist"));
        mockFs.rmdir.mockRejectedValue(new Error("Folder does not exist"));
        mockFs.stat.mockRejectedValue(new Error("does not exist"));
        await expect(deviceChatFiles.remove("chat/d/x")).resolves.toBeUndefined();
        await expect(deviceChatFiles.removeDir("chat/d/out/u")).resolves.toBeUndefined();
        expect(mockFs.rmdir).toHaveBeenCalledWith({ path: "chat/d/out/u", directory: "DATA", recursive: true });
    });

    it("a delete that fails on a file still there is an error", async () => {
        mockFs.deleteFile.mockRejectedValue(new Error("permission denied"));
        mockFs.stat.mockResolvedValue({ size: 3 });
        await expect(deviceChatFiles.remove("chat/d/x")).rejects.toThrow("permission denied");
    });
});

describe("memoryChatFiles", () => {
    it("holds bytes by relative path", async () => {
        const files = memoryChatFiles();
        expect(await files.writeBlob("chat/d/a", new Blob([new Uint8Array([1, 2, 3])]))).toBe(3);
        expect(await files.size("chat/d/a")).toBe(3);
        expect(await files.size("chat/d/none")).toBeNull();
        files.put("content://picked/1", new Uint8Array([9, 9]));
        expect(await files.copyFrom("content://picked/1", "chat/d/out/u/b")).toBe(2);
        await files.rename("chat/d/out/u/b", "chat/d/files/1/b");
        expect(files.bytes("chat/d/files/1/b")).toEqual(new Uint8Array([9, 9]));
        expect(files.bytes("chat/d/out/u/b")).toBeUndefined();
        await files.removeDir("chat/d/files");
        expect(files.bytes("chat/d/files/1/b")).toBeUndefined();
        expect(files.bytes("chat/d/a")).toEqual(new Uint8Array([1, 2, 3]));
        await files.remove("chat/d/a");
        expect(await files.size("chat/d/a")).toBeNull();
        expect(await files.uri("chat/d/a")).toMatch(/chat\/d\/a$/);
    });
});
