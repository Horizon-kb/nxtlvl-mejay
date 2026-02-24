export interface TrueEndTimeOptions {
  /**
   * Silence threshold in dBFS (negative). Typical: -50 to -60.
   * Default: -55.
   */
  silenceThresholdDb?: number;
  /**
   * How long the signal must stay under the threshold to be considered trailing silence.
   * Default: 700ms.
   */
  minSilenceMs?: number;
  /**
   * Don’t set the “true end” inside the last N seconds of the file.
   * Prevents trimming extremely short tails / codec padding edge cases.
   * Default: 1.5s.
   */
  minCutBeforeEndSec?: number;
}

const dbToLinear = (db: number): number => {
  // dBFS is amplitude referenced to full-scale (1.0).
  return Math.pow(10, db / 20);
};

/**
 * Computes the best-guess end-of-audio time by finding sustained low-amplitude samples
 * at the end of the track.
 *
 * This is intended for *offline* analysis (import time), not real-time.
 */
export function detectTrueEndTimeFromChannelData(
  channelData: Float32Array,
  sampleRate: number,
  durationSec: number,
  opts: TrueEndTimeOptions = {},
): number {
  const silenceThresholdDb = Number.isFinite(opts.silenceThresholdDb)
    ? (opts.silenceThresholdDb as number)
    : -55;
  const minSilenceMs = Number.isFinite(opts.minSilenceMs) ? (opts.minSilenceMs as number) : 700;
  const minCutBeforeEndSec = Number.isFinite(opts.minCutBeforeEndSec)
    ? (opts.minCutBeforeEndSec as number)
    : 1.5;

  if (!channelData || channelData.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return durationSec;
  }

  const threshold = dbToLinear(silenceThresholdDb);
  const minSilenceSamples = Math.max(1, Math.floor((sampleRate * minSilenceMs) / 1000));

  let silenceCount = 0;
  let silenceStartSample: number | null = null;

  for (let i = channelData.length - 1; i >= 0; i--) {
    const v = channelData[i];
    if (Math.abs(v) < threshold) {
      silenceCount += 1;
      if (silenceCount >= minSilenceSamples) {
        silenceStartSample = i;
      }
    } else {
      silenceCount = 0;
      // Once we’ve found a trailing-silence region and then hit real signal,
      // we can stop scanning.
      if (silenceStartSample !== null) break;
    }
  }

  if (silenceStartSample === null) return durationSec;

  const silenceStartTime = silenceStartSample / sampleRate;

  // Safety rail: never cut too close to the actual end.
  const latestAllowedCut = Math.max(0, durationSec - Math.max(0, minCutBeforeEndSec));
  const trueEndTime = Math.min(silenceStartTime, latestAllowedCut);

  // Clamp to valid range.
  return Math.max(0, Math.min(durationSec, trueEndTime));
}

export function detectTrueEndTime(audioBuffer: AudioBuffer, opts: TrueEndTimeOptions = {}): number {
  const durationSec = audioBuffer?.duration ?? 0;
  const sampleRate = audioBuffer?.sampleRate ?? 0;
  if (!audioBuffer || !Number.isFinite(durationSec) || durationSec <= 0 || sampleRate <= 0) {
    return durationSec;
  }

  // Mono is fine for v1; channel 0 is a good proxy.
  const ch0 = audioBuffer.getChannelData(0);
  const result = detectTrueEndTimeFromChannelData(ch0, sampleRate, durationSec, opts);
  
  // Dev logging
  if (typeof globalThis !== 'undefined' && (globalThis as any).import?.meta?.env?.DEV) {
    const trimmedMs = Math.round((durationSec - result) * 1000);
    console.log('[detectTrueEndTime]', {
      duration: durationSec.toFixed(2),
      trueEnd: result.toFixed(2),
      silenceTrimmed: trimmedMs > 0 ? `${trimmedMs}ms` : 'none',
    });
  }
  
  return result;
}
