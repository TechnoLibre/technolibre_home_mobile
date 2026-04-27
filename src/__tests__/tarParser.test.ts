import { describe, it, expect } from "vitest";
import { parseTarBuffer, TarEntry } from "../utils/tarParser";

/**
 * Helper: build a minimal ustar header block for a single file entry.
 * 512 bytes total. Octal-ASCII fields, NUL-terminated.
 */
function makeTarHeader(name: string, size: number, type: "0" | "5" = "0"): Uint8Array {
    const block = new Uint8Array(512);
    const enc = new TextEncoder();
    block.set(enc.encode(name.slice(0, 100)), 0);
    // mode 0644
    block.set(enc.encode("000644 \0"), 100);
    // uid/gid
    block.set(enc.encode("000000 \0"), 108);
    block.set(enc.encode("000000 \0"), 116);
    // size: octal, 11 chars + NUL
    block.set(enc.encode(size.toString(8).padStart(11, "0") + "\0"), 124);
    // mtime
    block.set(enc.encode("00000000000\0"), 136);
    // checksum placeholder (8 spaces during calculation)
    block.set(enc.encode("        "), 148);
    // type flag
    block[156] = enc.encode(type)[0];
    // ustar magic
    block.set(enc.encode("ustar\0"), 257);
    block.set(enc.encode("00"), 263);
    // checksum: sum of bytes
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

function endOfArchive(): Uint8Array {
    return new Uint8Array(1024); // two zero blocks
}

function concat(parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
}

describe("tarParser", () => {
    it("parses a single file entry", async () => {
        const content = new TextEncoder().encode("hello tar");
        const tar = concat([makeTarFile("hello.txt", content), endOfArchive()]);
        const entries: TarEntry[] = [];
        for await (const e of parseTarBuffer(tar)) entries.push(e);
        expect(entries).toHaveLength(1);
        expect(entries[0].name).toBe("hello.txt");
        expect(entries[0].size).toBe(content.length);
        expect(entries[0].isFile).toBe(true);
        expect(new TextDecoder().decode(entries[0].content!)).toBe("hello tar");
    });

    it("parses multiple files with padding", async () => {
        const a = new TextEncoder().encode("a".repeat(513));  // forces padding
        const b = new TextEncoder().encode("bb");
        const tar = concat([makeTarFile("a.bin", a), makeTarFile("b.bin", b), endOfArchive()]);
        const entries: TarEntry[] = [];
        for await (const e of parseTarBuffer(tar)) entries.push(e);
        expect(entries.map((e) => e.name)).toEqual(["a.bin", "b.bin"]);
        expect(entries[0].content!.length).toBe(513);
        expect(entries[1].content!.length).toBe(2);
    });

    it("parses a directory entry without content", async () => {
        const dirHeader = makeTarHeader("subdir/", 0, "5");
        const tar = concat([dirHeader, endOfArchive()]);
        const entries: TarEntry[] = [];
        for await (const e of parseTarBuffer(tar)) entries.push(e);
        expect(entries[0].isDirectory).toBe(true);
        expect(entries[0].isFile).toBe(false);
    });

    it("ignores end-of-archive padding", async () => {
        const tar = concat([makeTarFile("only.txt", new Uint8Array([1, 2, 3])), endOfArchive()]);
        const entries: TarEntry[] = [];
        for await (const e of parseTarBuffer(tar)) entries.push(e);
        expect(entries).toHaveLength(1);
    });

    it("rejects truncated input", async () => {
        const tar = makeTarHeader("truncated.txt", 100, "0").slice(0, 256); // half a header
        await expect(async () => {
            const entries: TarEntry[] = [];
            for await (const e of parseTarBuffer(tar)) entries.push(e);
        }).rejects.toThrow();
    });
});
