// BPM Detection using Web Audio API
// Analyzes audio data to detect tempo

interface PeakInfo {
  position: number;
  volume: number;
}

export async function detectBPM(audioBuffer: AudioBuffer): Promise<{ bpm: number; confidence: number }> {
  // Get the audio data from the first channel
  const channelData = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;
  
  // We'll analyze a portion of the track (middle section often has clearest beat)
  const analyzeSeconds = Math.min(30, audioBuffer.duration);
  const startSample = Math.floor((audioBuffer.duration / 2 - analyzeSeconds / 2) * sampleRate);
  const endSample = Math.min(startSample + Math.floor(analyzeSeconds * sampleRate), channelData.length);
  
  // Apply low-pass filter to focus on bass frequencies
  const filteredData = lowPassFilter(channelData, sampleRate, startSample, endSample);
  
  // Find peaks in the audio signal
  const peaks = findPeaks(filteredData, sampleRate);
  
  if (peaks.length < 10) {
    return { bpm: 0, confidence: 0 };
  }
  
  // Calculate intervals between peaks
  const intervals = calculateIntervals(peaks, sampleRate);
  
  // Find the most common interval (likely the beat interval)
  const { bpm, confidence } = findBPM(intervals);
  
  return { bpm: Math.round(bpm * 10) / 10, confidence };
}

function lowPassFilter(
  data: Float32Array,
  sampleRate: number,
  startSample: number,
  endSample: number
): Float32Array {
  // Simple moving average as a low-pass filter
  const windowSize = Math.floor(sampleRate / 100); // 10ms window
  const length = endSample - startSample;
  const filtered = new Float32Array(length);
  
  for (let i = 0; i < length; i++) {
    let sum = 0;
    const start = Math.max(0, i - windowSize);
    const end = Math.min(length - 1, i + windowSize);
    
    for (let j = start; j <= end; j++) {
      sum += Math.abs(data[startSample + j]);
    }
    
    filtered[i] = sum / (end - start + 1);
  }
  
  return filtered;
}

function findPeaks(data: Float32Array, sampleRate: number): PeakInfo[] {
  const peaks: PeakInfo[] = [];
  const threshold = calculateThreshold(data);
  const minPeakDistance = Math.floor(sampleRate * 0.15); // Minimum 150ms between peaks
  
  let lastPeakPos = -minPeakDistance;
  
  for (let i = 1; i < data.length - 1; i++) {
    // Check if this is a local maximum above threshold
    if (
      data[i] > threshold &&
      data[i] > data[i - 1] &&
      data[i] > data[i + 1] &&
      i - lastPeakPos > minPeakDistance
    ) {
      peaks.push({ position: i, volume: data[i] });
      lastPeakPos = i;
    }
  }
  
  return peaks;
}

function calculateThreshold(data: Float32Array): number {
  // Calculate dynamic threshold based on signal energy
  let sum = 0;
  let max = 0;
  
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
    if (data[i] > max) max = data[i];
  }
  
  const average = sum / data.length;
  return average + (max - average) * 0.3;
}

function calculateIntervals(peaks: PeakInfo[], sampleRate: number): number[] {
  const intervals: number[] = [];
  
  for (let i = 1; i < peaks.length; i++) {
    const interval = (peaks[i].position - peaks[i - 1].position) / sampleRate;
    // Only consider intervals that correspond to 60-200 BPM
    const bpm = 60 / interval;
    if (bpm >= 60 && bpm <= 200) {
      intervals.push(interval);
    }
  }
  
  return intervals;
}

function findBPM(intervals: number[]): { bpm: number; confidence: number } {
  if (intervals.length === 0) {
    return { bpm: 0, confidence: 0 };
  }
  
  // Group intervals into buckets
  const buckets = new Map<number, number>();
  const bucketSize = 0.01; // 10ms buckets
  
  for (const interval of intervals) {
    const bucket = Math.round(interval / bucketSize) * bucketSize;
    buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
  }
  
  // Find the most common bucket
  let maxCount = 0;
  let bestBucket = 0;
  
  for (const [bucket, count] of buckets) {
    if (count > maxCount) {
      maxCount = count;
      bestBucket = bucket;
    }
  }
  
  // Guard against zero or Infinity (Priority 5 - Issue #3)
  if (bestBucket === 0 || !Number.isFinite(bestBucket)) {
    return { bpm: 0, confidence: 0 };
  }
  
  const bpm = 60 / bestBucket;
  
  // Guard against Infinity result (Priority 5 - Issue #3)
  if (!Number.isFinite(bpm) || bpm <= 0) {
    return { bpm: 0, confidence: 0 };
  }
  
  // Clamp confidence to [0,1] (Priority 5 - Issue #14)
  const confidence = Math.min(1, maxCount / intervals.length);
  
  // Normalize BPM to common ranges
  let normalizedBPM = bpm;
  while (normalizedBPM < 80) normalizedBPM *= 2;
  while (normalizedBPM > 160) normalizedBPM /= 2;
  
  return { bpm: normalizedBPM, confidence };
}

// Analyze BPM from a Blob
export async function analyzeBPM(blob: Blob): Promise<{ bpm: number; hasBeat: boolean }> {
  try {
    const audioContext = new AudioContext();
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    
    const result = await detectBPM(audioBuffer);
    
    audioContext.close();
    
    return {
      bpm: result.bpm,
      hasBeat: result.confidence > 0.3 && result.bpm > 0,
    };
  } catch (error) {
    console.error('BPM detection failed:', error);
    return { bpm: 0, hasBeat: false };
  }
}
