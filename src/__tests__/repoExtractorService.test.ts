import { describe, it, expect, vi, beforeEach } from "vitest";
import { gzipSync } from "node:zlib";

const { mockFs, mockFetch } = vi.hoisted(() => ({
    mockFs: {
        readFile: vi.fn(),
        writeFile: vi.fn(),
        mkdir: vi.fn(),
        stat: vi.fn(),
        deleteFile: vi.fn(),
        readdir: vi.fn(),
        rmdir: vi.fn(),
    },
    mockFetch: vi.fn(),
}));

vi.mock("@capacitor/filesystem", () => ({
    Filesystem: mockFs,
    Directory: { Cache: "CACHE", Data: "DATA" },
    Encoding: { UTF8: "utf8" },
}));

global.fetch = mockFetch as unknown as typeof fetch;

function makeTarHeader(name: string, size: number, type: "0" | "5" = "0"): Uint8Array {
    const block = new Uint8Array(512);
    const enc = new TextEncoder();
    block.set(enc.encode(name.slice(0, 100)), 0);
    block.set(enc.encode("000644 \0"), 100);
    block.set(enc.encode("000000 \0"), 108);
    block.set(enc.encode("000000 \0"), 116);
    block.set(enc.encode(size.toString(8).padStart(11, "0") + "\0"), 124);
    block.set(enc.encode("00000000000\0"), 136);
    block.set(enc.encode("        "), 148);
    block[156] = enc.encode(type)[0];
    block.set(enc.encode("ustar\0"), 257);
    block.set(enc.encode("00"), 263);
    let cksum = 0;
    for (let i = 0; i < 512; i++) cksum += block[i];
    block.set(enc.encode(cksum.toString(8).padStart(6, "0") + "\0 "), 148);
    return block;
}

function makeTarFile(name: string, content: Uint8Array): Uint8Array {
    const header = makeTarHeader(name, content.length, "0");
    const padded = new Uint8Array(Math.ceil(content.length / 512) * 512);
    padded.set(content, 0);
    const out = new Uint8Array(header.length + padded.length);
    out.set(header, 0);
    out.set(padded, header.length);
    return out;
}

function fixtureTarGz(): Uint8Array {
    const enc = new TextEncoder();
    const tar = new Uint8Array([
        ...makeTarFile("README.md", enc.encode("# Hello")),
        ...makeTarFile("src/main.py", enc.encode('print("hi")')),
        ...makeTarFile("index.json", enc.encode('[{"path":"README.md","type":"file"}]')),
        ...new Uint8Array(1024),
    ]);
    return new Uint8Array(gzipSync(tar));
}

import { RepoExtractorService } from "../services/repoExtractorService";

describe("RepoExtractorService", () => {
    beforeEach(() => {
        Object.values(mockFs).forEach((fn) => fn.mockReset());
        mockFetch.mockReset();
    });

    it("extracts an archive on first call", async () => {
        // First call: sentinel doesn't exist.
        mockFs.stat.mockRejectedValueOnce(new Error("ENOENT"));
        mockFs.mkdir.mockResolvedValue(undefined);
        mockFs.writeFile.mockResolvedValue(undefined);
        mockFetch.mockResolvedValue(new Response(fixtureTarGz()));

        const svc = new RepoExtractorService();
        const dir = await svc.ensureExtracted("test-slug", "/repos/test-slug.tar.gz");

        expect(dir).toContain("test-slug");
        // README.md, src/main.py, index.json, .extracted sentinel
        expect(mockFs.writeFile).toHaveBeenCalledTimes(4);
        const writeCalls = mockFs.writeFile.mock.calls.map((c) => c[0].path);
        expect(writeCalls).toContain("repos/test-slug/README.md");
        expect(writeCalls).toContain("repos/test-slug/src/main.py");
        expect(writeCalls.some((p: string) => p.endsWith("/.extracted"))).toBe(true);
    });

    it("is idempotent on second call (sentinel hit)", async () => {
        mockFs.stat.mockResolvedValue({ type: "file", size: 12, mtime: 0 });
        const svc = new RepoExtractorService();
        await svc.ensureExtracted("cached", "/repos/cached.tar.gz");
        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockFs.writeFile).not.toHaveBeenCalled();
    });

    it("dedupes concurrent extractions for the same slug", async () => {
        mockFs.stat.mockRejectedValue(new Error("ENOENT"));
        mockFs.mkdir.mockResolvedValue(undefined);
        mockFs.writeFile.mockResolvedValue(undefined);
        mockFetch.mockResolvedValue(new Response(fixtureTarGz()));

        const svc = new RepoExtractorService();
        const [a, b] = await Promise.all([
            svc.ensureExtracted("dup", "/repos/dup.tar.gz"),
            svc.ensureExtracted("dup", "/repos/dup.tar.gz"),
        ]);
        expect(a).toBe(b);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("rejects when archive download fails", async () => {
        mockFs.stat.mockRejectedValue(new Error("ENOENT"));
        mockFetch.mockResolvedValue(new Response(null, { status: 404 }));
        const svc = new RepoExtractorService();
        await expect(svc.ensureExtracted("missing", "/repos/missing.tar.gz"))
            .rejects.toThrow(/BundleNotShipped|404/);
    });
});
