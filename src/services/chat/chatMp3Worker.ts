import { encodeMp3 } from "./chatMp3";

/** A request: mono samples and their rate. */
export interface Mp3Job {
    samples: Float32Array;
    sampleRate: number;
}

/** The answer: the MP3 bytes (transferred), or the encoder's error as text. */
export type Mp3Result = { mp3: Uint8Array } | { error: string };

/**
 * Encodes one Mp3Job per message off the UI thread and posts back an
 * Mp3Result; the MP3's buffer is transferred, not copied.
 */
self.onmessage = (event: MessageEvent<Mp3Job>) => {
    const { samples, sampleRate } = event.data;
    let result: Mp3Result;
    try {
        result = { mp3: encodeMp3(samples, sampleRate) };
    } catch (e) {
        result = { error: e instanceof Error ? e.message : String(e) };
    }
    // The options form is both the worker's postMessage and the one the DOM types declare on self
    self.postMessage(result, { transfer: "mp3" in result ? [result.mp3.buffer as ArrayBuffer] : [] });
};
