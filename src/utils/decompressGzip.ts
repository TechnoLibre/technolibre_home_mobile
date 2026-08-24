/**
 * Thin wrappers around the WebView's native DecompressionStream('gzip').
 *
 * Available since Chrome 80 — Android WebView on minSdk 24 has been past
 * this version since 2020. If a runtime ever turns up without it, callers
 * see a clear ReferenceError.
 */

export function gunzipStream(
    input: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
    return input.pipeThrough(new DecompressionStream("gzip"));
}

export async function gunzipBytes(input: Uint8Array): Promise<Uint8Array> {
    const stream = new Response(input).body;
    if (!stream) throw new Error("Response has no body — cannot gunzip");
    const out = stream.pipeThrough(new DecompressionStream("gzip"));
    const reader = out.getReader();
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
    return merged;
}
