package ca.erplibre.home;

import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.util.Log;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;

/**
 * Converts a compressed audio file (M4A / AAC / OGG / …) to a 16 kHz mono
 * float[] array suitable for whisper.cpp transcription.
 *
 * Uses Android's built-in MediaExtractor + MediaCodec — no extra libraries.
 */
public class AudioConverter {

    private static final String TAG = "AudioConverter";
    private static final int TARGET_SAMPLE_RATE = 16000;
    private static final long TIMEOUT_US = 10_000L;

    /**
     * @param inputPath absolute path to the audio file
     * @return PCM samples normalised to [-1, 1] at 16 kHz mono
     */
    public static float[] convertToWhisperFormat(String inputPath) throws IOException {
        Log.d(TAG, "Converting: " + inputPath);

        MediaExtractor extractor = new MediaExtractor();
        extractor.setDataSource(inputPath);

        // ── 1. Find the first audio track ────────────────────────────────────
        int audioTrackIndex = -1;
        MediaFormat format = null;
        for (int i = 0; i < extractor.getTrackCount(); i++) {
            MediaFormat tf = extractor.getTrackFormat(i);
            String mime = tf.getString(MediaFormat.KEY_MIME);
            if (mime != null && mime.startsWith("audio/")) {
                audioTrackIndex = i;
                format = tf;
                break;
            }
        }
        if (audioTrackIndex < 0 || format == null) {
            extractor.release();
            throw new IOException("No audio track found in: " + inputPath);
        }

        int srcSampleRate  = format.getInteger(MediaFormat.KEY_SAMPLE_RATE);
        int channelCount   = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
        String mime        = format.getString(MediaFormat.KEY_MIME);

        Log.d(TAG, String.format("Track: mime=%s, rate=%d, channels=%d",
                mime, srcSampleRate, channelCount));

        extractor.selectTrack(audioTrackIndex);

        // ── 2. Decode to raw PCM (16-bit LE shorts) ──────────────────────────
        MediaCodec decoder = MediaCodec.createDecoderByType(mime);
        decoder.configure(format, null, null, 0);
        decoder.start();

        List<short[]> chunks = new ArrayList<>();
        int totalShorts = 0;
        boolean inputDone  = false;
        boolean outputDone = false;
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();

        while (!outputDone) {
            if (!inputDone) {
                int inputIdx = decoder.dequeueInputBuffer(TIMEOUT_US);
                if (inputIdx >= 0) {
                    ByteBuffer inputBuf = decoder.getInputBuffer(inputIdx);
                    if (inputBuf == null) continue;
                    int sampleSize = extractor.readSampleData(inputBuf, 0);
                    if (sampleSize < 0) {
                        decoder.queueInputBuffer(inputIdx, 0, 0, 0,
                                MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                        inputDone = true;
                    } else {
                        decoder.queueInputBuffer(inputIdx, 0, sampleSize,
                                extractor.getSampleTime(), 0);
                        extractor.advance();
                    }
                }
            }

            int outputIdx = decoder.dequeueOutputBuffer(info, TIMEOUT_US);
            if (outputIdx >= 0) {
                ByteBuffer outputBuf = decoder.getOutputBuffer(outputIdx);
                if (outputBuf != null && info.size > 0) {
                    outputBuf.position(info.offset);
                    outputBuf.limit(info.offset + info.size);
                    outputBuf.order(ByteOrder.LITTLE_ENDIAN);

                    int shortCount = info.size / 2;
                    short[] chunk = new short[shortCount];
                    outputBuf.asShortBuffer().get(chunk);
                    chunks.add(chunk);
                    totalShorts += shortCount;
                }
                decoder.releaseOutputBuffer(outputIdx, false);
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                    outputDone = true;
                }
            }
        }

        decoder.stop();
        decoder.release();
        extractor.release();

        // ── 3. Merge chunks ──────────────────────────────────────────────────
        short[] pcm = new short[totalShorts];
        int pos = 0;
        for (short[] chunk : chunks) {
            System.arraycopy(chunk, 0, pcm, pos, chunk.length);
            pos += chunk.length;
        }

        // ── 4. Downmix to mono ───────────────────────────────────────────────
        if (channelCount > 1) {
            int monoLen = pcm.length / channelCount;
            short[] mono = new short[monoLen];
            for (int i = 0; i < monoLen; i++) {
                long sum = 0;
                for (int c = 0; c < channelCount; c++) {
                    sum += pcm[i * channelCount + c];
                }
                mono[i] = (short) (sum / channelCount);
            }
            pcm = mono;
        }

        // ── 5. Resample to 16 kHz (linear interpolation) ────────────────────
        if (srcSampleRate != TARGET_SAMPLE_RATE) {
            pcm = resample(pcm, srcSampleRate, TARGET_SAMPLE_RATE);
        }

        // ── 6. Normalise to float [-1, 1] ────────────────────────────────────
        float[] result = new float[pcm.length];
        for (int i = 0; i < pcm.length; i++) {
            result[i] = pcm[i] / 32768.0f;
        }

        Log.d(TAG, "Conversion done: " + result.length + " samples at " +
                TARGET_SAMPLE_RATE + " Hz");
        return result;
    }

    private static short[] resample(short[] input, int srcRate, int dstRate) {
        if (srcRate == dstRate) return input;
        int outLen = (int) ((long) input.length * dstRate / srcRate);
        short[] output = new short[outLen];
        for (int i = 0; i < outLen; i++) {
            double srcIdx = (double) i * srcRate / dstRate;
            int low  = (int) srcIdx;
            int high = Math.min(low + 1, input.length - 1);
            double frac = srcIdx - low;
            output[i] = (short) (input[low] * (1.0 - frac) + input[high] * frac);
        }
        return output;
    }
}
