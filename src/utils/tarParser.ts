/**
 * Streaming tar reader. Supports plain ustar archives — sufficient for
 * what GNU `tar -czf` produces from typical source trees.
 *
 * Two entry points:
 *   parseTarBuffer(bytes)  — convenience for tests, eager
 *   parseTarStream(stream) — production, async iterable over a
 *                            ReadableStream<Uint8Array>
 *
 * The parser does NOT handle GNU long-name extensions (PAX) explicitly;
 * filenames longer than 100 bytes use the ustar prefix field, which is
 * read here. Files larger than 8 GB (octal size overflow) are rejected.
 */

const BLOCK = 512;

export interface TarEntry {
    name: string;
    size: number;
    isDirectory: boolean;
    isFile: boolean;
    mode: number;
    /** Present iff isFile. */
    content?: Uint8Array;
}

function readOctalString(view: Uint8Array, off: number, len: number): string {
    let end = off + len;
    while (end > off && (view[end - 1] === 0 || view[end - 1] === 0x20)) end--;
    return new TextDecoder().decode(view.subarray(off, end)).trim();
}

function readNullTermString(view: Uint8Array, off: number, len: number): string {
    let end = off;
    const limit = off + len;
    while (end < limit && view[end] !== 0) end++;
    return new TextDecoder().decode(view.subarray(off, end));
}

function isAllZero(view: Uint8Array): boolean {
    for (let i = 0; i < view.length; i++) if (view[i] !== 0) return false;
    return true;
}

function parseHeader(block: Uint8Array): { entry: TarEntry; isEndMarker: boolean } | null {
    if (block.length !== BLOCK) {
        throw new Error(`tar header expected ${BLOCK} bytes, got ${block.length}`);
    }
    if (isAllZero(block)) return { entry: null as unknown as TarEntry, isEndMarker: true };

    const name = readNullTermString(block, 0, 100);
    const sizeOctal = readOctalString(block, 124, 12);
    const size = parseInt(sizeOctal, 8);
    if (!Number.isFinite(size) || size < 0) {
        throw new Error(`tar: invalid size field "${sizeOctal}"`);
    }
    const modeOctal = readOctalString(block, 100, 8);
    const mode = parseInt(modeOctal, 8) || 0o644;
    const typeFlag = String.fromCharCode(block[156] || 0x30); // '0' if zero
    const prefix = readNullTermString(block, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;

    const isDirectory = typeFlag === "5" || fullName.endsWith("/");
    const isFile = typeFlag === "0" || typeFlag === "" || typeFlag === " ";
    return {
        entry: { name: fullName, size, isDirectory, isFile, mode },
        isEndMarker: false,
    };
}

/** Eager parser for use in tests. */
export async function* parseTarBuffer(bytes: Uint8Array): AsyncGenerator<TarEntry> {
    let offset = 0;
    while (offset + BLOCK <= bytes.length) {
        const headerBlock = bytes.subarray(offset, offset + BLOCK);
        const parsed = parseHeader(headerBlock);
        offset += BLOCK;
        if (!parsed) continue;
        if (parsed.isEndMarker) return;
        const { entry } = parsed;

        if (entry.isFile && entry.size > 0) {
            if (offset + entry.size > bytes.length) {
                throw new Error(`tar: truncated content for ${entry.name}`);
            }
            entry.content = bytes.subarray(offset, offset + entry.size);
            offset += entry.size;
            // Pad to BLOCK.
            const pad = (BLOCK - (entry.size % BLOCK)) % BLOCK;
            offset += pad;
        }
        yield entry;
    }
    // If we got here without seeing the end-of-archive marker, the input was truncated.
    throw new Error("tar: unexpected end of archive (no zero blocks seen)");
}

/** Streaming parser for production use. */
export async function* parseTarStream(
    stream: ReadableStream<Uint8Array>,
): AsyncGenerator<TarEntry> {
    const reader = stream.getReader();
    let buffer = new Uint8Array(0);
    let done = false;

    async function pull(): Promise<void> {
        if (done) return;
        const r = await reader.read();
        if (r.done) { done = true; return; }
        const merged = new Uint8Array(buffer.length + r.value.length);
        merged.set(buffer, 0);
        merged.set(r.value, buffer.length);
        buffer = merged;
    }

    while (true) {
        while (buffer.length < BLOCK && !done) await pull();
        if (buffer.length < BLOCK) {
            throw new Error("tar: stream ended in the middle of a header");
        }
        const headerBlock = buffer.subarray(0, BLOCK);
        const parsed = parseHeader(headerBlock);
        buffer = buffer.subarray(BLOCK);
        if (!parsed) continue;
        if (parsed.isEndMarker) return;
        const { entry } = parsed;

        if (entry.isFile && entry.size > 0) {
            const padded = entry.size + ((BLOCK - (entry.size % BLOCK)) % BLOCK);
            while (buffer.length < padded && !done) await pull();
            if (buffer.length < entry.size) {
                throw new Error(`tar: stream truncated mid-content for ${entry.name}`);
            }
            entry.content = buffer.slice(0, entry.size);
            buffer = buffer.subarray(padded);
        }
        yield entry;
    }
}
