import { Mp3Encoder } from "@breezystack/lamejs";

/** Bitrate of a voice message, kbit/s: Odoo's own browser recorder encodes mono at 128. */
export const VOICE_MP3_KBPS = 128;

/** Samples per MPEG-1 Layer III frame: the block encodeBuffer is fed. */
const FRAME_SAMPLES = 1152;

/**
 * samples (mono, -1..1) as an MP3 at sampleRate, mono, 128 kbit/s
 * constant: each 1152-sample block clamped to -1..1 and scaled to 16-bit
 * PCM, then the encoder flushed so the last partial frame is written.
 * The phone runs it in a worker (chatMp3Worker.ts), off the UI thread.
 */
export function encodeMp3(samples: Float32Array, sampleRate: number): Uint8Array {
    const encoder = new Mp3Encoder(1, sampleRate, VOICE_MP3_KBPS);
    const chunks: Uint8Array[] = [];
    const pcm = new Int16Array(FRAME_SAMPLES);
    for (let i = 0; i < samples.length; i += FRAME_SAMPLES) {
        const block = samples.subarray(i, i + FRAME_SAMPLES);
        const out = block.length === FRAME_SAMPLES ? pcm : new Int16Array(block.length);
        for (let j = 0; j < block.length; j++) {
            const s = Math.max(-1, Math.min(1, block[j]));
            out[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        chunks.push(encoder.encodeBuffer(out));
    }
    chunks.push(encoder.flush());
    // The encoder hands back signed bytes: set() stores each one modulo 256
    const mp3 = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
        mp3.set(c, at);
        at += c.length;
    }
    return mp3;
}

/** The buffer's channels averaged into one, at the buffer's length. */
export function mixToMono(buffer: AudioBuffer): Float32Array {
    const channels = buffer.numberOfChannels;
    if (channels === 1) return Float32Array.from(buffer.getChannelData(0));
    const mono = new Float32Array(buffer.length);
    for (let c = 0; c < channels; c++) {
        const data = buffer.getChannelData(c);
        for (let i = 0; i < mono.length; i++) mono[i] += data[i];
    }
    for (let i = 0; i < mono.length; i++) mono[i] /= channels;
    return mono;
}

/**
 * `Voice-YYYY-MM-DD-<0..99999>.mp3`, the name Odoo's browser recorder
 * gives: the UTC date of now, then an integer drawn from random.
 */
export function voiceName(now: Date, random: () => number = Math.random): string {
    return `Voice-${now.toISOString().split("T")[0]}-${Math.floor(random() * 100000)}.mp3`;
}
