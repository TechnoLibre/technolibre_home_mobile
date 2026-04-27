import { describe, it, expect } from "vitest";
import { gunzipBytes, gunzipStream } from "../utils/decompressGzip";
import { gzipSync } from "node:zlib";

describe("decompressGzip", () => {
    it("gunzipBytes round-trips simple data", async () => {
        const input = new TextEncoder().encode("hello world");
        const gz = gzipSync(input);
        const out = await gunzipBytes(new Uint8Array(gz));
        expect(new TextDecoder().decode(out)).toBe("hello world");
    });

    it("gunzipStream feeds a ReadableStream through DecompressionStream", async () => {
        const input = new TextEncoder().encode("streamed".repeat(100));
        const gz = gzipSync(input);
        const stream = new Response(new Uint8Array(gz)).body!;
        const ungz = gunzipStream(stream);
        const reader = ungz.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
            const r = await reader.read();
            if (r.done) break;
            chunks.push(r.value);
        }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { merged.set(c, off); off += c.length; }
        expect(new TextDecoder().decode(merged)).toBe("streamed".repeat(100));
    });
});
