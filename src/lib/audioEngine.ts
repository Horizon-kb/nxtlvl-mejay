// Web Audio API based audio engine for ME Jay
// Provides dual-deck playback, crossfading, tempo control, and volume matching

import { computeClampedTempoRatio } from './tempoMatch';

export type DeckId = 'A' | 'B';

export type VibesPreset = 'flat' | 'warm' | 'bright' | 'club' | 'vocal';

export enum DeckStateEnum {
  EMPTY = 'EMPTY',           // No track loaded
  LOADING = 'LOADING',       // Awaiting decode
  READY = 'READY',           // Track loaded, can play
  PLAYING = 'PLAYING',       // Audio running
  STOPPING = 'STOPPING',     // Requested stop
  STOPPED = 'STOPPED',       // Fully stopped
  ERROR = 'ERROR'            // Error state
}

interface DeckState {
  state: DeckStateEnum;      // Current deck lifecycle state
  audioBuffer: AudioBuffer | null;
  sourceNode: AudioBufferSourceNode | null;
  gainNode: GainNode | null;
  trackGainNode: GainNode | null; // Per-track gain for volume matching
  playbackRate: number;
  baseBpm: number; // Original detected BPM
  isPlaying: boolean;
  currentTime: number;
  // Track-time bookkeeping (seconds in the audio buffer timeline)
  trackAtLastCtx: number;
  lastCtx: number;
  pausedAt: number;
  duration: number;
  /** Optional analyzed “musical end” time used for transition planning. */
  trueEndTime: number | null;
  trackGainDb: number; // Applied gain adjustment
  scheduledStartAt: number | null;
  scheduledStartTimeoutId: number | null;
  tempoRamp: {
    startTime: number;
    endTime: number;
    startRate: number;
    endRate: number;
  } | null;
}

class AudioEngine {
  private audioContext: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private masterVolume: number = 1;
  private limiterNode: DynamicsCompressorNode | null = null;
  private ceilingNode: GainNode | null = null;
  
  // Per-deck ignore flag: stop()/restart() will trigger onended — don't treat it like a natural track finish
  private ignoreNextEnded: Record<DeckId, number> = { A: 0, B: 0 };

  // Master tone shaping (pre-limiter)
  private preLimiterGain: GainNode | null = null;
  private vibeLowShelf: BiquadFilterNode | null = null;
  private vibeMidPeak: BiquadFilterNode | null = null;
  private vibeHighShelf: BiquadFilterNode | null = null;
  private vibesPreset: VibesPreset = 'flat';
  private decks: Record<DeckId, DeckState> = {
    A: this.createEmptyDeck(),
    B: this.createEmptyDeck(),
  };
  private crossfadeValue: number = 0.5; // 0 = full A, 1 = full B
  private onTimeUpdate: ((deck: DeckId, time: number) => void) | null = null;
  private onTrackEnd: ((deck: DeckId) => void) | null = null;
  private onMixTrigger: (() => void) | null = null;
  private animationFrameId: number | null = null;
  private mixCheckEnabled: boolean = false;
  private mixTriggerMode: 'remaining' | 'elapsed' | 'manual' = 'remaining';
  private mixTriggerSeconds: number = 20;
  private mixTriggered: boolean = false;
  private limiterEnabled: boolean = true;
  private limiterStrength: 'light' | 'medium' | 'strong' = 'medium';

  private createEmptyDeck(): DeckState {
    return {
      state: DeckStateEnum.EMPTY,
      audioBuffer: null,
      sourceNode: null,
      gainNode: null,
      trackGainNode: null,
      playbackRate: 1,
      baseBpm: 120,
      isPlaying: false,
      currentTime: 0,
      trackAtLastCtx: 0,
      lastCtx: 0,
      pausedAt: 0,
      duration: 0,
      trueEndTime: null,
      trackGainDb: 0,
      scheduledStartAt: null,
      scheduledStartTimeoutId: null,
      tempoRamp: null,
    };
  }

  private logEvent(event: string, data: Record<string, any>): void {
    if (import.meta.env.DEV) {
      const ts = this.audioContext?.currentTime ?? Date.now();
      console.log(`[AudioEngine/${event}] @${ts}`, data);
    }
    // TODO Phase 2: Optional remote telemetry
  }

  private dbToLinear(db: number): number {
    return Math.pow(10, db / 20);
  }

  private clampDb(db: number, minDb: number, maxDb: number): number {
    if (!Number.isFinite(db)) return 0;
    return Math.max(minDb, Math.min(maxDb, db));
  }

  private getVibesParams(preset: VibesPreset): {
    low: {freq: number; gainDb: number}
    mid: {freq: number; q: number; gainDb: number}
    high: {freq: number; gainDb: number}
  } {
    switch (preset) {
      case 'warm':
        return {
          low: {freq: 120, gainDb: 3},
          mid: {freq: 350, q: 0.8, gainDb: 0},
          high: {freq: 8000, gainDb: -0.5},
        };
      case 'bright':
        return {
          low: {freq: 140, gainDb: -0.5},
          mid: {freq: 3000, q: 1.0, gainDb: 1},
          high: {freq: 9000, gainDb: 3},
        };
      case 'club':
        return {
          low: {freq: 100, gainDb: 4},
          mid: {freq: 500, q: 0.9, gainDb: -0.5},
          high: {freq: 9000, gainDb: 1.5},
        };
      case 'vocal':
        return {
          low: {freq: 120, gainDb: -1},
          mid: {freq: 320, q: 1.1, gainDb: -2},
          high: {freq: 6000, gainDb: 1.5},
        };
      case 'flat':
      default:
        return {
          low: {freq: 120, gainDb: 0},
          mid: {freq: 400, q: 1.0, gainDb: 0},
          high: {freq: 8000, gainDb: 0},
        };
    }
  }

  private applyVibesPreset(preset: VibesPreset, opts?: {ms?: number}): void {
    if (!this.audioContext) return;
    if (!this.preLimiterGain || !this.vibeLowShelf || !this.vibeMidPeak || !this.vibeHighShelf) return;

    const ms = Math.max(0, Math.min(2000, opts?.ms ?? 200));
    const now = this.audioContext.currentTime;
    const params = this.getVibesParams(preset);

    this.vibeLowShelf.type = 'lowshelf';
    this.vibeHighShelf.type = 'highshelf';
    this.vibeMidPeak.type = 'peaking';

    // Keep frequencies/Q static; smooth only gain + trim.
    this.vibeLowShelf.frequency.value = params.low.freq;
    this.vibeHighShelf.frequency.value = params.high.freq;
    this.vibeMidPeak.frequency.value = params.mid.freq;
    this.vibeMidPeak.Q.value = params.mid.q;

    const smooth = (param: AudioParam, value: number) => {
      const t = now;
      const end = t + ms / 1000;
      try {
        param.cancelScheduledValues(t);
        param.setValueAtTime(param.value, t);
        param.linearRampToValueAtTime(value, end);
      } catch {
        try {
          param.value = value;
        } catch {
          // ignore
        }
      }
    };

    smooth(this.vibeLowShelf.gain, params.low.gainDb);
    smooth(this.vibeMidPeak.gain, params.mid.gainDb);
    smooth(this.vibeHighShelf.gain, params.high.gainDb);

    // Pre-limiter trim to reduce constant limiting for boosted presets.
    const maxBoost = Math.max(0, params.low.gainDb, params.mid.gainDb, params.high.gainDb);
    const trimDb = -Math.min(3, Math.max(0, maxBoost * 0.75));
    smooth(this.preLimiterGain.gain, this.dbToLinear(trimDb));
  }

  setVibesPreset(preset: VibesPreset, opts?: {ms?: number}): void {
    this.vibesPreset = preset;
    this.applyVibesPreset(preset, opts);
  }

  getAudioContextTime(): number | null {
    return this.audioContext?.currentTime ?? null;
  }

  setTrueEndTime(deck: DeckId, trueEndTime: number | null | undefined): void {
    const deckState = this.decks[deck];
    if (typeof trueEndTime !== 'number' || !Number.isFinite(trueEndTime) || trueEndTime <= 0) {
      if (import.meta.env.DEV && trueEndTime !== null && trueEndTime !== undefined) {
        console.warn(`[setTrueEndTime] Rejecting invalid value for deck ${deck}:`, trueEndTime);
      }
      deckState.trueEndTime = null;
      return;
    }

    const dur = deckState.duration;
    deckState.trueEndTime = (Number.isFinite(dur) && dur > 0)
      ? Math.max(0, Math.min(dur, trueEndTime))
      : trueEndTime;
    
    if (import.meta.env.DEV) {
      this.logEvent('trueEndTime_set', {
        deck,
        trueEndTime: deckState.trueEndTime,
        duration: deckState.duration,
      });
    }
  }

  private getEffectivePlaybackRateAt(deck: DeckId, ctxTime: number): number {
    const deckState = this.decks[deck];
    const ramp = deckState.tempoRamp;
    if (!ramp) return deckState.playbackRate;

    if (ctxTime <= ramp.startTime) return deckState.playbackRate;
    if (ctxTime >= ramp.endTime) return ramp.endRate;

    const duration = Math.max(0.001, ramp.endTime - ramp.startTime);
    const t = (ctxTime - ramp.startTime) / duration;
    return ramp.startRate + (ramp.endRate - ramp.startRate) * t;
  }

  private updateTrackPositionTo(deck: DeckId, ctxTime: number): void {
    if (!this.audioContext) return;
    const deckState = this.decks[deck];

    // If not playing, keep bookkeeping aligned to pausedAt.
    if (!deckState.isPlaying) {
      deckState.trackAtLastCtx = deckState.pausedAt;
      deckState.lastCtx = ctxTime;
      return;
    }

    if (ctxTime <= deckState.lastCtx) return;

    const ramp = deckState.tempoRamp;
    if (!ramp) {
      const elapsed = ctxTime - deckState.lastCtx;
      // Clamp to duration to prevent overflow (Priority 4 - Issue #2)
      deckState.trackAtLastCtx = Math.min(deckState.duration, deckState.trackAtLastCtx + elapsed * deckState.playbackRate);
      deckState.lastCtx = ctxTime;
      return;
    }

    // Segment 1: before ramp start
    if (deckState.lastCtx < ramp.startTime) {
      const t1 = Math.min(ctxTime, ramp.startTime);
      const elapsed = t1 - deckState.lastCtx;
      if (elapsed > 0) {
        // Clamp to duration (Priority 4 - Issue #2)
        deckState.trackAtLastCtx = Math.min(deckState.duration, deckState.trackAtLastCtx + elapsed * deckState.playbackRate);
        deckState.lastCtx = t1;
      }
    }

    // Segment 2: during ramp
    if (deckState.lastCtx < ctxTime && deckState.lastCtx < ramp.endTime && ctxTime > ramp.startTime) {
      const segStart = Math.max(deckState.lastCtx, ramp.startTime);
      const segEnd = Math.min(ctxTime, ramp.endTime);

      if (segEnd > segStart) {
        const dur = Math.max(0.001, ramp.endTime - ramp.startTime);
        const k = (ramp.endRate - ramp.startRate) / dur;

        const a = segStart - ramp.startTime;
        const b = segEnd - ramp.startTime;

        // Integral of (startRate + k*(t - startTime)) dt from segStart..segEnd
        const integral = ramp.startRate * (segEnd - segStart) + 0.5 * k * (b * b - a * a);
        // Clamp to duration to prevent overflow (Priority 4 - Issue #2)
        deckState.trackAtLastCtx = Math.min(deckState.duration, deckState.trackAtLastCtx + integral);
        deckState.lastCtx = segEnd;
      }
    }

    // Segment 3: after ramp end
    if (ctxTime >= ramp.endTime && deckState.lastCtx >= ramp.endTime) {
      // Ramp is completed; adopt the end rate.
      deckState.playbackRate = ramp.endRate;
      deckState.tempoRamp = null;
    }

    if (!deckState.tempoRamp && deckState.lastCtx < ctxTime) {
      const elapsed = ctxTime - deckState.lastCtx;
      // Clamp to duration (Priority 4 - Issue #2)
      deckState.trackAtLastCtx = Math.min(deckState.duration, deckState.trackAtLastCtx + elapsed * deckState.playbackRate);
      deckState.lastCtx = ctxTime;
    }
  }

  /**
   * Returns the next beat-aligned AudioContext time for the given deck.
   *
   * Beat alignment is computed against the deck's base BPM (beat grid in buffer time),
   * and then converted to AudioContext time using the deck's current playbackRate.
   */
  getNextBeatTime(deck: DeckId, beatMultiple: number = 1): number | null {
    if (!this.audioContext) return null;

    const deckState = this.decks[deck];
    const bpm = deckState.baseBpm || 120;
    const rate = this.getEffectivePlaybackRateAt(deck, this.audioContext.currentTime) || 1;

    // Strict validation: guard against Infinity/NaN (Priority 2 - Issue #4)
    if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(rate) || rate <= 0) {
      this.logEvent('getNextBeatTime_invalid_params', { deck, bpm, rate });
      return this.audioContext.currentTime;
    }

    const beatIntervalTrack = (60 / bpm) * Math.max(1, Math.floor(beatMultiple));
    const trackTime = this.getCurrentTime(deck);
    const phase = trackTime % beatIntervalTrack;
    const remainingTrack = phase === 0 ? beatIntervalTrack : beatIntervalTrack - phase;
    const remainingReal = remainingTrack / rate;

    return this.audioContext.currentTime + remainingReal;
  }

  /**
   * Returns the next beat-aligned time at or after `fromTime`.
   * Uses `playbackRateOverride` when provided (useful when tempo is being ramped).
   */
  getNextBeatTimeFrom(deck: DeckId, fromTime: number, beatMultiple: number = 1, playbackRateOverride?: number): number | null {
    if (!this.audioContext) return null;
    const deckState = this.decks[deck];
    const bpm = deckState.baseBpm || 120;
    const rate = (playbackRateOverride ?? this.getEffectivePlaybackRateAt(deck, fromTime)) || 1;
    if (!bpm || bpm <= 0 || rate <= 0) return fromTime;

    const intervalTrack = (60 / bpm) * Math.max(1, Math.floor(beatMultiple));
    // Compute track position at `fromTime` using the current piecewise model.
    const baseTrackAtLast = deckState.isPlaying ? deckState.trackAtLastCtx : deckState.pausedAt;
    const baseLastCtx = deckState.isPlaying ? deckState.lastCtx : fromTime;
    const clampedFrom = Math.max(fromTime, baseLastCtx);
    const trackTimeAtFrom = baseTrackAtLast + (clampedFrom - baseLastCtx) * rate;
    const nextBoundaryTrack = Math.ceil(trackTimeAtFrom / intervalTrack) * intervalTrack;
    const remainingTrack = nextBoundaryTrack - trackTimeAtFrom;
    const remainingReal = remainingTrack / rate;
    return clampedFrom + remainingReal;
  }

  /** Returns the previous beat-aligned AudioContext time at or before `fromTime`. */
  getPrevBeatTimeFrom(deck: DeckId, fromTime: number, beatMultiple: number = 1, playbackRateOverride?: number): number | null {
    if (!this.audioContext) return null;
    const deckState = this.decks[deck];
    const bpm = deckState.baseBpm || 120;
    const rate = (playbackRateOverride ?? this.getEffectivePlaybackRateAt(deck, fromTime)) || 1;
    if (!bpm || bpm <= 0 || rate <= 0) return fromTime;

    const intervalTrack = (60 / bpm) * Math.max(1, Math.floor(beatMultiple));

    // Compute track position at `fromTime` using the current piecewise model.
    const baseTrackAtLast = deckState.isPlaying ? deckState.trackAtLastCtx : deckState.pausedAt;
    const baseLastCtx = deckState.isPlaying ? deckState.lastCtx : fromTime;
    const clampedFrom = Math.max(fromTime, baseLastCtx);
    const trackTimeAtFrom = baseTrackAtLast + (clampedFrom - baseLastCtx) * rate;

    const prevBoundaryTrack = Math.floor(trackTimeAtFrom / intervalTrack) * intervalTrack;
    const elapsedTrack = trackTimeAtFrom - prevBoundaryTrack;
    const elapsedReal = elapsedTrack / rate;
    return clampedFrom - elapsedReal;
  }

  private clearScheduledStart(deck: DeckId): void {
    const deckState = this.decks[deck];
    if (deckState.scheduledStartTimeoutId !== null) {
      clearTimeout(deckState.scheduledStartTimeoutId);
      deckState.scheduledStartTimeoutId = null;
    }
    deckState.scheduledStartAt = null;
  }

  /**
   * Start playback at a specific AudioContext time.
   *
   * Note: this schedules audio precisely, but deckState.isPlaying flips to true via setTimeout.
   */
  playAt(deck: DeckId, whenTime: number): void {
    if (!this.audioContext || !this.decks[deck].audioBuffer) return;

    // Resume audio context if suspended (mobile browsers)
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    const deckState = this.decks[deck];
    
    // Guard by state: only play if READY or PLAYING (prevents race condition)
    if (deckState.state !== DeckStateEnum.READY && deckState.state !== DeckStateEnum.PLAYING) {
      this.logEvent('playAt_blocked', {
        deck,
        reason: `state is ${deckState.state}, expected READY or PLAYING`,
      });
      return;
    }
    
    if (deckState.isPlaying) return;
    
    // Update state
    deckState.state = DeckStateEnum.PLAYING;
    this.logEvent('playAt_scheduled', { deck, whenTime });

    // Cancel any previous schedule
    this.clearScheduledStart(deck);
    // Preserve any pre-set offset (e.g. loadTrackWithOffset)
    const preservedOffset = deckState.pausedAt;
    this.stop(deck);
    deckState.pausedAt = preservedOffset;
    deckState.trackAtLastCtx = preservedOffset;
    deckState.lastCtx = 0;

    // Create new source node now and schedule its start
    const source = this.audioContext.createBufferSource();
    source.buffer = deckState.audioBuffer;
    source.playbackRate.value = deckState.playbackRate;
    source.connect(deckState.trackGainNode!);

    const offset = deckState.pausedAt;
    const safeWhen = Math.max(this.audioContext.currentTime, whenTime);

    // Entry ramp (avoid abrupt loudness at start).
    try {
      const gainNode = deckState.trackGainNode;
      if (gainNode) {
        const targetLinear = this.dbToLinear(this.clampDb(deckState.trackGainDb, -12, 12));
        const startLinear = Math.min(targetLinear, 0.25);
        const rampSeconds = 0.5;
        gainNode.gain.cancelScheduledValues(safeWhen);
        gainNode.gain.setValueAtTime(startLinear, safeWhen);
        gainNode.gain.linearRampToValueAtTime(targetLinear, safeWhen + rampSeconds);
      }
    } catch {
      // ignore
    }

    source.start(safeWhen, offset);
    deckState.sourceNode = source;
    deckState.trackAtLastCtx = offset;
    deckState.lastCtx = safeWhen;
    deckState.scheduledStartAt = safeWhen;

    const delayMs = Math.max(0, (safeWhen - this.audioContext.currentTime) * 1000);
    deckState.scheduledStartTimeoutId = window.setTimeout(() => {
      deckState.isPlaying = true;
      deckState.scheduledStartTimeoutId = null;
      deckState.scheduledStartAt = null;
    }, delayMs);

    source.onended = () => {
      // stop()/restart will trigger onended — don't treat it like a natural track finish
      if ((this.ignoreNextEnded[deck] ?? 0) > Date.now()) return;
      
      if (deckState.isPlaying) {
        deckState.isPlaying = false;
        deckState.pausedAt = 0;
        this.onTrackEnd?.(deck);
      }
    };
  }

  async initialize(): Promise<void> {
    if (this.audioContext) return;

    this.audioContext = new AudioContext();
    
    // Create master chain: deck gains -> preLimiter (trim) -> EQ -> limiter -> ceiling -> master gain -> destination
    this.masterGain = this.audioContext.createGain();
    this.masterGain.gain.value = Math.max(0, Math.min(1, this.masterVolume));

    this.preLimiterGain = this.audioContext.createGain();
    this.preLimiterGain.gain.value = 1;

    this.vibeLowShelf = this.audioContext.createBiquadFilter();
    this.vibeMidPeak = this.audioContext.createBiquadFilter();
    this.vibeHighShelf = this.audioContext.createBiquadFilter();

    this.limiterNode = this.audioContext.createDynamicsCompressor();
    this.ceilingNode = this.audioContext.createGain();
    // ~ -1 dBFS ceiling (safer than 0 dBFS).
    this.ceilingNode.gain.value = Math.pow(10, -1 / 20);
    
    this.updateLimiter();

    // Wire master processing graph.
    this.preLimiterGain.connect(this.vibeLowShelf);
    this.vibeLowShelf.connect(this.vibeMidPeak);
    this.vibeMidPeak.connect(this.vibeHighShelf);
    this.vibeHighShelf.connect(this.limiterNode);
    
    this.limiterNode.connect(this.ceilingNode);
    this.ceilingNode.connect(this.masterGain);
    this.masterGain.connect(this.audioContext.destination);

    // Create gain nodes for each deck
    // Chain: source -> trackGainNode (volume match) -> gainNode (crossfade) -> limiter
    for (const deckId of ['A', 'B'] as DeckId[]) {
      this.decks[deckId].trackGainNode = this.audioContext.createGain();
      this.decks[deckId].gainNode = this.audioContext.createGain();
      this.decks[deckId].trackGainNode!.connect(this.decks[deckId].gainNode!);
      this.decks[deckId].gainNode!.connect(this.preLimiterGain);
    }

    this.updateCrossfade();
    this.startTimeUpdateLoop();

    // Ensure a deterministic starting tone.
    this.applyVibesPreset(this.vibesPreset, { ms: 0 });
  }

  private updateLimiter(): void {
    if (!this.limiterNode) return;
    
    if (!this.limiterEnabled) {
      // Bypass limiter
      this.limiterNode.threshold.value = 0;
      this.limiterNode.ratio.value = 1;
      return;
    }
    
    // Configure limiter based on strength
    switch (this.limiterStrength) {
      case 'light':
        this.limiterNode.threshold.value = -3;
        this.limiterNode.knee.value = 0;
        this.limiterNode.ratio.value = 10;
        this.limiterNode.attack.value = 0.003;
        this.limiterNode.release.value = 0.25;
        break;
      case 'medium':
        this.limiterNode.threshold.value = -6;
        this.limiterNode.knee.value = 0;
        this.limiterNode.ratio.value = 20;
        this.limiterNode.attack.value = 0.003;
        this.limiterNode.release.value = 0.25;
        break;
      case 'strong':
        this.limiterNode.threshold.value = -10;
        this.limiterNode.knee.value = 0;
        this.limiterNode.ratio.value = 40;
        this.limiterNode.attack.value = 0.001;
        this.limiterNode.release.value = 0.2;
        break;
    }
  }

  setLimiterEnabled(enabled: boolean): void {
    this.limiterEnabled = enabled;
    this.updateLimiter();
  }

  setLimiterStrength(strength: 'light' | 'medium' | 'strong'): void {
    this.limiterStrength = strength;
    this.updateLimiter();
  }

  private startTimeUpdateLoop(): void {
    const update = () => {
      if (this.onTimeUpdate) {
        if (this.decks.A.isPlaying) {
          const time = this.getCurrentTime('A');
          this.onTimeUpdate('A', time);
          
          // Check mix trigger for deck A
          this.checkMixTrigger('A', time);
          
          // Check if track ended
          if (time >= this.decks.A.duration && this.decks.A.duration > 0) {
            this.onTrackEnd?.('A');
          }
        }
        if (this.decks.B.isPlaying) {
          const time = this.getCurrentTime('B');
          this.onTimeUpdate('B', time);
          
          // Check mix trigger for deck B
          this.checkMixTrigger('B', time);
          
          if (time >= this.decks.B.duration && this.decks.B.duration > 0) {
            this.onTrackEnd?.('B');
          }
        }
      }
      this.animationFrameId = requestAnimationFrame(update);
    };
    this.animationFrameId = requestAnimationFrame(update);
  }

  private checkMixTrigger(deck: DeckId, currentTime: number): void {
    if (!this.mixCheckEnabled || this.mixTriggered) return;
    
    const deckState = this.decks[deck];
    const effectiveEnd = (typeof deckState.trueEndTime === 'number' && Number.isFinite(deckState.trueEndTime) && deckState.trueEndTime > 0)
      ? deckState.trueEndTime
      : deckState.duration;
    const remaining = effectiveEnd - currentTime;
    
    let shouldTrigger = false;
    
    if (this.mixTriggerMode === 'remaining' && remaining <= this.mixTriggerSeconds) {
      shouldTrigger = true;
    } else if (this.mixTriggerMode === 'elapsed' && currentTime >= this.mixTriggerSeconds) {
      shouldTrigger = true;
    }
    
    if (shouldTrigger) {
      this.mixTriggered = true;
      this.onMixTrigger?.();
    }
  }

  setMixTriggerConfig(mode: 'remaining' | 'elapsed' | 'manual', seconds: number): void {
    this.mixTriggerMode = mode;
    this.mixTriggerSeconds = seconds;
  }

  enableMixCheck(enabled: boolean): void {
    this.mixCheckEnabled = enabled;
    this.mixTriggered = false;
  }

  resetMixTrigger(): void {
    this.mixTriggered = false;
  }

  setOnMixTrigger(callback: () => void): void {
    this.onMixTrigger = callback;
  }

  setOnTimeUpdate(callback: (deck: DeckId, time: number) => void): void {
    this.onTimeUpdate = callback;
  }

  setOnTrackEnd(callback: (deck: DeckId) => void): void {
    this.onTrackEnd = callback;
  }

  // Measure loudness of an audio buffer (RMS proxy for LUFS)
  measureLoudness(audioBuffer: AudioBuffer): number {
    const channelData = audioBuffer.getChannelData(0);
    let sumSquares = 0;
    
    // Sample every 100th sample for performance
    const step = 100;
    let count = 0;
    
    for (let i = 0; i < channelData.length; i += step) {
      sumSquares += channelData[i] * channelData[i];
      count++;
    }
    
    const rms = Math.sqrt(sumSquares / count);
    const db = 20 * Math.log10(rms + 0.0001); // Avoid log(0)
    
    return db;
  }

  // Calculate gain to match target loudness
  calculateGain(measuredDb: number, targetDb: number): number {
    return targetDb - measuredDb;
  }

  // Apply per-track gain for volume matching
  setTrackGain(deck: DeckId, gainDb: number): void {
    const deckState = this.decks[deck];
    deckState.trackGainDb = gainDb;
    
    if (deckState.trackGainNode) {
      // Convert dB to linear gain, clamped to reasonable range
      const clampedDb = this.clampDb(gainDb, -12, 12);
      const linearGain = this.dbToLinear(clampedDb);
      const now = this.audioContext?.currentTime ?? 0;
      try {
        deckState.trackGainNode.gain.cancelScheduledValues(now);
        deckState.trackGainNode.gain.setTargetAtTime(linearGain, now, 0.2);
      } catch (error) {
        this.logEvent('setTrackGain_ramp_failed', {
          deck,
          error: String(error),
          fallback: 'immediate',
        });
        try {
          deckState.trackGainNode.gain.value = linearGain;
        } catch {
          // Silent fallback if immediate set also fails
        }
      }
    }
  }

  async loadTrack(deck: DeckId, blob: Blob, bpm?: number, gainDb?: number): Promise<number> {
    await this.initialize();
    
    if (!this.audioContext) throw new Error('Audio context not initialized');

    const deckState = this.decks[deck];
    deckState.state = DeckStateEnum.LOADING;
    this.logEvent('load_track_started', { deck });

    // Stop any current playback on this deck
    this.stop(deck);
    deckState.state = DeckStateEnum.LOADING;  // Re-set after stop cleared it

    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
    
    // Validate audio buffer (Priority 2 - Issue #5)
    if (!Number.isFinite(audioBuffer.duration) || audioBuffer.duration <= 0) {
      deckState.state = DeckStateEnum.ERROR;
      this.logEvent('load_track_failed', { deck, reason: `Invalid duration: ${audioBuffer.duration}` });
      throw new Error(
        `Invalid audio buffer: duration must be > 0 (got ${audioBuffer.duration})`
      );
    }
    
    this.decks[deck].audioBuffer = audioBuffer;
    this.decks[deck].duration = audioBuffer.duration;
    this.decks[deck].trueEndTime = null;
    this.decks[deck].currentTime = 0;
    this.decks[deck].pausedAt = 0;
    this.decks[deck].baseBpm = bpm || 120;
    // Ensure each new load starts from a known tempo baseline.
    this.decks[deck].playbackRate = 1;
    this.decks[deck].tempoRamp = null;
    
    // Apply track gain if provided
    if (gainDb !== undefined) {
      this.setTrackGain(deck, gainDb);
    } else {
      // Reset to neutral when not applying auto-volume.
      this.setTrackGain(deck, 0);
    }

    deckState.state = DeckStateEnum.READY;
    this.logEvent('load_track_ready', { deck, duration: audioBuffer.duration });
    return audioBuffer.duration;
  }

  // Load track and set initial offset (start at X seconds)
  async loadTrackWithOffset(deck: DeckId, blob: Blob, offsetSeconds: number, bpm?: number, gainDb?: number): Promise<number> {
    const duration = await this.loadTrack(deck, blob, bpm, gainDb);
    const clampedOffset = Math.max(0, Math.min(offsetSeconds, duration - 1));
    this.decks[deck].pausedAt = clampedOffset;
    return duration;
  }

  // Analyze and store loudness for a blob
  async analyzeLoudness(blob: Blob): Promise<{ loudnessDb: number; gainDb: number }> {
    await this.initialize();
    if (!this.audioContext) throw new Error('Audio context not initialized');
    
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
    
    const loudnessDb = this.measureLoudness(audioBuffer);
    // Target: -14 dB (streaming standard) adjusted by user preference
    const targetDb = -14;
    const gainDb = this.calculateGain(loudnessDb, targetDb);
    
    return { loudnessDb, gainDb };
  }

  getBaseBpm(deck: DeckId): number {
    return this.decks[deck].baseBpm;
  }

  setBaseBpm(deck: DeckId, bpm: number): void {
    // Validate BPM (Priority 2 - Issue #13)
    if (!Number.isFinite(bpm) || bpm <= 0) {
      this.logEvent('setBaseBpm_invalid', { deck, bpm, fallback: 120 });
      this.decks[deck].baseBpm = 120;
    } else {
      this.decks[deck].baseBpm = bpm;
    }
  }

  // Calculate tempo ratio to match target BPM
  calculateTempoRatio(deck: DeckId, targetBpm: number, maxPercent: number): number {
    const baseBpm = this.decks[deck].baseBpm;
    const result = computeClampedTempoRatio({
      baseBpm,
      targetBpm,
      maxTempoPercent: maxPercent,
      minRatioFloor: 0.25,
      maxRatioCeil: 4,
    });
    return result.clampedRatio;
  }

  // Match deck B's tempo to deck A (or to a locked BPM)
  matchTempo(targetBpm: number, maxPercent: number): void {
    const ratio = this.calculateTempoRatio('B', targetBpm, maxPercent);
    this.setTempo('B', ratio);
  }

  play(deck: DeckId): void {
    if (!this.audioContext || !this.decks[deck].audioBuffer) return;

    // Resume audio context if suspended (mobile browsers)
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    const deckState = this.decks[deck];
    
    // Guard by state: only play if READY or PLAYING (prevents race condition)
    if (deckState.state !== DeckStateEnum.READY && deckState.state !== DeckStateEnum.PLAYING) {
      this.logEvent('play_blocked', {
        deck,
        reason: `state is ${deckState.state}, expected READY or PLAYING`,
      });
      return;
    }
    
    // If already playing, do nothing
    if (deckState.isPlaying) return;
    
    // Update state
    deckState.state = DeckStateEnum.PLAYING;
    this.logEvent('play_started', { deck });

    // Create new source node
    const source = this.audioContext.createBufferSource();
    source.buffer = deckState.audioBuffer;
    source.playbackRate.value = deckState.playbackRate;
    source.connect(deckState.trackGainNode!);

    // Calculate start offset
    const offset = deckState.pausedAt;

    // Entry ramp (avoid abrupt loudness at start).
    try {
      if (this.audioContext && deckState.trackGainNode) {
        const now = this.audioContext.currentTime;
        const targetLinear = this.dbToLinear(this.clampDb(deckState.trackGainDb, -12, 12));
        const startLinear = Math.min(targetLinear, 0.25);
        const rampSeconds = 0.5;
        deckState.trackGainNode.gain.cancelScheduledValues(now);
        deckState.trackGainNode.gain.setValueAtTime(startLinear, now);
        deckState.trackGainNode.gain.linearRampToValueAtTime(targetLinear, now + rampSeconds);
      }
    } catch {
      // ignore
    }
    
    source.start(0, offset);
    deckState.sourceNode = source;
    deckState.trackAtLastCtx = offset;
    deckState.lastCtx = this.audioContext.currentTime;
    deckState.isPlaying = true;

    // Handle track end
    source.onended = () => {
      // stop()/restart will trigger onended — don't treat it like a natural track finish
      if ((this.ignoreNextEnded[deck] ?? 0) > Date.now()) return;
      
      if (deckState.isPlaying) {
        deckState.isPlaying = false;
        deckState.pausedAt = 0;
        this.onTrackEnd?.(deck);
      }
    };
  }

  pause(deck: DeckId): void {
    const deckState = this.decks[deck];
    if (!deckState.isPlaying || !deckState.sourceNode) return;

    deckState.pausedAt = this.getCurrentTime(deck);
    deckState.trackAtLastCtx = deckState.pausedAt;
    deckState.lastCtx = this.audioContext?.currentTime ?? deckState.lastCtx;
    deckState.sourceNode.stop();
    deckState.sourceNode.disconnect();
    deckState.sourceNode = null;
    deckState.isPlaying = false;
    deckState.state = DeckStateEnum.STOPPED;
    this.logEvent('pause', { deck, position: deckState.pausedAt });
  }

  // Call before stop() when you *don't* want onended to be treated as a real ending
  ignoreEndedFor(deck: DeckId, ms = 300): void {
    const until = Date.now() + ms;
    this.ignoreNextEnded[deck] = Math.max(this.ignoreNextEnded[deck] ?? 0, until);
  }

  stop(deck: DeckId): void {
    const deckState = this.decks[deck];
    this.clearScheduledStart(deck);
    deckState.state = DeckStateEnum.STOPPING;
    if (deckState.sourceNode) {
      try {
        deckState.sourceNode.stop();
        deckState.sourceNode.disconnect();
      } catch (e) {
        // Ignore errors from already stopped sources
      }
    }
    deckState.sourceNode = null;
    deckState.isPlaying = false;
    deckState.pausedAt = 0;
    deckState.trackAtLastCtx = 0;
    deckState.lastCtx = 0;
    deckState.currentTime = 0;
    deckState.tempoRamp = null;
    deckState.state = DeckStateEnum.STOPPED;
    this.logEvent('stop', { deck });
  }

  getCurrentTime(deck: DeckId): number {
    const deckState = this.decks[deck];
    if (!this.audioContext || !deckState.isPlaying) {
      return deckState.pausedAt;
    }

    this.updateTrackPositionTo(deck, this.audioContext.currentTime);
    return Math.min(deckState.trackAtLastCtx, deckState.duration);
  }

  getDuration(deck: DeckId): number {
    return this.decks[deck].duration;
  }

  isPlaying(deck: DeckId): boolean {
    return this.decks[deck].isPlaying;
  }

  setTempo(deck: DeckId, ratio: number): void {
    const deckState = this.decks[deck];

    if (this.audioContext && deckState.isPlaying) {
      this.updateTrackPositionTo(deck, this.audioContext.currentTime);
    }

    deckState.tempoRamp = null;
    deckState.playbackRate = ratio;
    if (this.audioContext) {
      deckState.lastCtx = this.audioContext.currentTime;
    }
    
    if (deckState.sourceNode) {
      const rateParam = deckState.sourceNode.playbackRate;
      const now = this.audioContext?.currentTime ?? 0;
      // Ensure any previously scheduled ramp/automation is cancelled so this change is immediate.
      rateParam.cancelScheduledValues(now);
      rateParam.setValueAtTime(ratio, now);
    }
  }

  /**
   * Ramps playbackRate smoothly. Uses AudioParam scheduling when a source node exists.
   */
  rampTempo(deck: DeckId, targetRatio: number, startAtTime: number, durationMs: number): void {
    if (!this.audioContext) return;
    const deckState = this.decks[deck];

    // Allow longer ramps so tempo changes can be tied to crossfades (up to ~20s).
    const clampedDurationMs = Math.max(150, Math.min(20000, durationMs));
    const startTime = Math.max(this.audioContext.currentTime, startAtTime);
    const endTime = startTime + clampedDurationMs / 1000;

    // If playing, bring bookkeeping up to ramp start.
    if (deckState.isPlaying) {
      this.updateTrackPositionTo(deck, startTime);
    }

    // Cancel any previous ramp.
    deckState.tempoRamp = null;

    const startRate = deckState.playbackRate;
    deckState.tempoRamp = {
      startTime,
      endTime,
      startRate,
      endRate: targetRatio,
    };

    if (!deckState.sourceNode) return;

    const rateParam = deckState.sourceNode.playbackRate;
    rateParam.cancelScheduledValues(startTime);
    rateParam.setValueAtTime(startRate, startTime);
    rateParam.linearRampToValueAtTime(targetRatio, endTime);
  }

  scheduleStop(deck: DeckId, whenTime: number): void {
    if (!this.audioContext) return;
    const deckState = this.decks[deck];
    if (!deckState.sourceNode) return;
    const safeWhen = Math.max(this.audioContext.currentTime, whenTime);
    try {
      deckState.sourceNode.stop(safeWhen);
    } catch {
      // ignore
    }
  }

  /**
   * Schedules an equal-power crossfade starting at `startAtTime`.
   */
  scheduleCrossfade(seconds: number, startAtTime: number): void {
    if (!this.audioContext || !this.decks.A.gainNode || !this.decks.B.gainNode) return;

    const startTime = Math.max(this.audioContext.currentTime, startAtTime);
    const endTime = startTime + seconds;

    const startValue = this.crossfadeValue;
    const endValue = startValue < 0.5 ? 1 : 0;

    const gainA = this.decks.A.gainNode.gain;
    const gainB = this.decks.B.gainNode.gain;

    gainA.cancelScheduledValues(startTime);
    gainB.cancelScheduledValues(startTime);

    gainA.setValueAtTime(Math.cos(startValue * Math.PI * 0.5), startTime);
    gainB.setValueAtTime(Math.sin(startValue * Math.PI * 0.5), startTime);

    gainA.linearRampToValueAtTime(Math.cos(endValue * Math.PI * 0.5), endTime);
    gainB.linearRampToValueAtTime(Math.sin(endValue * Math.PI * 0.5), endTime);

    this.crossfadeValue = endValue;
  }

  getTempo(deck: DeckId): number {
    return this.decks[deck].playbackRate;
  }

  /** Returns the deck's current effective playbackRate (includes any active ramp). */
  getEffectiveTempo(deck: DeckId, atTime?: number): number {
    if (!this.audioContext) return this.decks[deck].playbackRate;
    const t = atTime ?? this.audioContext.currentTime;
    return this.getEffectivePlaybackRateAt(deck, t) || this.decks[deck].playbackRate || 1;
  }

  /** True when a tempo ramp is scheduled/in progress at `atTime` (default: now). */
  isTempoRamping(deck: DeckId, atTime?: number): boolean {
    if (!this.audioContext) return false;
    const ramp = this.decks[deck].tempoRamp;
    if (!ramp) return false;
    const t = atTime ?? this.audioContext.currentTime;
    return t < ramp.endTime;
  }

  setCrossfade(value: number): void {
    const v = Math.max(0, Math.min(1, value));
    this.crossfadeValue = v;

    // If a crossfade was previously scheduled (e.g. an automix), cancel it so manual control wins.
    if (this.audioContext && this.decks.A.gainNode && this.decks.B.gainNode) {
      const now = this.audioContext.currentTime;
      try {
        this.decks.A.gainNode.gain.cancelScheduledValues(now);
        this.decks.B.gainNode.gain.cancelScheduledValues(now);
        this.decks.A.gainNode.gain.setValueAtTime(Math.cos(v * Math.PI * 0.5), now);
        this.decks.B.gainNode.gain.setValueAtTime(Math.sin(v * Math.PI * 0.5), now);
        return;
      } catch {
        // fall through to immediate set
      }
    }

    this.updateCrossfade();
  }

  private updateCrossfade(): void {
    if (!this.decks.A.gainNode || !this.decks.B.gainNode) return;

    // Equal power crossfade
    const gainA = Math.cos(this.crossfadeValue * Math.PI * 0.5);
    const gainB = Math.sin(this.crossfadeValue * Math.PI * 0.5);
    
    this.decks.A.gainNode.gain.value = gainA;
    this.decks.B.gainNode.gain.value = gainB;
  }

  async crossfade(seconds: number): Promise<void> {
    if (!this.audioContext || !this.decks.A.gainNode || !this.decks.B.gainNode) return;

    const startTime = this.audioContext.currentTime;
    const endTime = startTime + seconds;

    // Current crossfade position determines direction
    const startValue = this.crossfadeValue;
    const endValue = startValue < 0.5 ? 1 : 0;

    const gainA = this.decks.A.gainNode.gain;
    const gainB = this.decks.B.gainNode.gain;

    // Cancel any ongoing transitions
    gainA.cancelScheduledValues(startTime);
    gainB.cancelScheduledValues(startTime);

    // Set current values
    gainA.setValueAtTime(Math.cos(startValue * Math.PI * 0.5), startTime);
    gainB.setValueAtTime(Math.sin(startValue * Math.PI * 0.5), startTime);

    // Ramp to new values
    gainA.linearRampToValueAtTime(Math.cos(endValue * Math.PI * 0.5), endTime);
    gainB.linearRampToValueAtTime(Math.sin(endValue * Math.PI * 0.5), endTime);

    this.crossfadeValue = endValue;
  }

  seek(deck: DeckId, time: number): void {
    const deckState = this.decks[deck];
    const wasPlaying = deckState.isPlaying;
    
    if (wasPlaying) {
      this.pause(deck);
    }
    
    deckState.pausedAt = Math.max(0, Math.min(time, deckState.duration));
    
    if (wasPlaying) {
      this.play(deck);
    }
  }

  setMasterVolume(value: number): void {
    const v = Math.max(0, Math.min(1, value));
    this.masterVolume = v;
    if (this.masterGain) {
      this.masterGain.gain.value = v;
    }
  }

  destroy(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.stop('A');
    this.stop('B');
    
    // Explicit state reset (Priority 3 - cleanup)
    this.decks.A.state = DeckStateEnum.EMPTY;
    this.decks.B.state = DeckStateEnum.EMPTY;
    
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.masterGain = null;
    this.limiterNode = null;
    this.ceilingNode = null;
    this.preLimiterGain = null;
    this.vibeLowShelf = null;
    this.vibeMidPeak = null;
    this.vibeHighShelf = null;
    
    // Null out all deck node references (Priority 3 - cleanup)
    this.decks.A.gainNode = null;
    this.decks.A.trackGainNode = null;
    this.decks.B.gainNode = null;
    this.decks.B.trackGainNode = null;
  }
}

// Singleton instance
export const audioEngine = new AudioEngine();
