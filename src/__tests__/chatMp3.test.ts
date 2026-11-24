import { describe, it, expect } from "vitest";
import { encodeMp3, mixToMono, voiceName } from "../services/chat/chatMp3";

/** Bitrates of MPEG-1 Layer III by header index, kbit/s. */
const MPEG1_L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG1_RATES = [44100, 48000, 32000];

/** The MPEG-1 Layer III frames of mp3, walked header to header from its first byte. */
function frames(mp3: Uint8Array) {
    const found: { kbps: number; rate: number; mode: number }[] = [];
    let at = 0;
    while (at + 4 <= mp3.length) {
        if (mp3[at] !== 0xff || (mp3[at + 1] & 0xfe) !== 0xfa) throw new Error(`no frame header at ${at}`);
        const kbps = MPEG1_L3_KBPS[mp3[at + 2] >> 4];
        const rate = MPEG1_RATES[(mp3[at + 2] >> 2) & 3];
        const padding = (mp3[at + 2] >> 1) & 1;
        found.push({ kbps, rate, mode: mp3[at + 3] >> 6 });
        at += Math.floor((144 * kbps * 1000) / rate) + padding;
    }
    return found;
}

/** A 440 Hz tone of seconds at rate, amplitude amp. */
function tone(seconds: number, rate: number, amp = 0.5): Float32Array {
    const out = new Float32Array(Math.round(seconds * rate));
    for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * 440 * i) / rate);
    return out;
}

function fakeBuffer(channels: number[][]): AudioBuffer {
    return {
        numberOfChannels: channels.length,
        length: channels[0].length,
        sampleRate: 44100,
        getChannelData: (c: number) => Float32Array.from(channels[c]),
    } as unknown as AudioBuffer;
}

describe("chatMp3", () => {
    it("encodeMp3 makes mono 128 kbit/s frames", () => {
        const mp3 = encodeMp3(tone(3, 44100), 44100);
        expect(mp3).toBeInstanceOf(Uint8Array);
        expect([mp3[0], mp3[1]]).toEqual([0xff, 0xfb]);
        expect(mp3[2] >> 4).toBe(9);
        expect((mp3[2] >> 2) & 3).toBe(0);
        expect(mp3[3] >> 6).toBe(0b11);
        const all = frames(mp3);
        expect(all.every((f) => f.kbps === 128 && f.rate === 44100 && f.mode === 0b11)).toBe(true);
        // Every input sample is in a frame once flushed: 3 s is about 115 frames of 1152 samples
        const seconds = (all.length * 1152) / 44100;
        expect(seconds).toBeGreaterThanOrEqual(3);
        expect(seconds).toBeLessThan(3.15);
    });

    it("encodeMp3 keeps the source rate", () => {
        const all = frames(encodeMp3(tone(1, 48000), 48000));
        expect(all[0]).toEqual({ kbps: 128, rate: 48000, mode: 0b11 });
    });

    it("encodeMp3 clamps samples outside -1..1", () => {
        const loud = tone(0.5, 44100, 3);
        const clamped = loud.map((s) => Math.max(-1, Math.min(1, s)));
        const mp3 = encodeMp3(loud, 44100);
        expect(mp3.length).toBeGreaterThan(0);
        expect(mp3).toEqual(encodeMp3(clamped, 44100));
    });

    it("mixToMono averages the channels", () => {
        expect(Array.from(mixToMono(fakeBuffer([[0.5, -1, 0], [0.25, 1, 0.5]])))).toEqual([0.375, 0, 0.25]);
        expect(Array.from(mixToMono(fakeBuffer([[0.5, -0.5]])))).toEqual([0.5, -0.5]);
    });

    it("voiceName format and range", () => {
        const at = new Date("2026-03-07T23:30:00Z");
        expect(voiceName(at, () => 0)).toBe("Voice-2026-03-07-0.mp3");
        expect(voiceName(at, () => 0.999999999)).toBe("Voice-2026-03-07-99999.mp3");
        expect(voiceName(at, () => 0.123456)).toBe("Voice-2026-03-07-12345.mp3");
        expect(voiceName(new Date())).toMatch(/^Voice-\d{4}-\d{2}-\d{2}-\d{1,5}\.mp3$/);
    });
});
