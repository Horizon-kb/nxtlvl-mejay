import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { Track, Settings, getAllTracks, getSettings, addTrack, updateTrack, deleteTrack, updateSettings, generateId, getAllPlaylists, Playlist, addPlaylist, updatePlaylist, deletePlaylist, PartySource, resetLocalDatabase, clearTracksAndPlaylists } from '@/lib/db';
import { audioEngine, DeckId } from '@/lib/audioEngine';
import { detectBPM } from '@/lib/bpmDetector';
import { computeClampedTempoRatio, computeRequiredTempoShiftPercent, isOverTempoCap, resolveMaxTempoPercent } from '@/lib/tempoMatch';
import { TEMPO_PRESET_RATIOS, computePresetTempo } from '@/lib/tempoPresets';
// Note: Energy Mode automation removed; mixing uses manual sliders only.
import { usePlanStore } from '@/stores/planStore';
import { toast } from '@/hooks/use-toast';
import { detectTrueEndTime } from '@/lib/trueEndTime';
import { valentine2026Pack, partyPack } from '@/config/starterPacks';

interface DeckState {
  trackId: string | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  playbackRate: number;
}

interface DJState {
  // Tracks
  tracks: Track[];
  isLoadingTracks: boolean;

  // Playlists
  playlists: Playlist[];

  // Deck states
  deckA: DeckState;
  deckB: DeckState;
  activeDeck: DeckId;

  // Party mode
  isPartyMode: boolean;
  partySource: PartySource | null;
  partyTrackIds: string[]; // The full list (doesn't shrink)
  nowPlayingIndex: number; // Current position in partyTrackIds
  pendingNextIndex: number | null; // For "Play Next" without immediate jump

  // History stack for Back behavior (shuffle-safe, no recompute).
  // Stores previously-played track IDs in the order they were visited.
  playHistoryTrackIds: string[];

  // Pending smooth source switch (applied after the mix completes)
  pendingSourceSwitch: { source: PartySource; trackIds: string[] } | null;

  // If user changes source while a mix is running, queue it.
  queuedSourceSwitch: PartySource | null;

  // Settings
  settings: Settings;

  // Crossfade
  crossfadeValue: number;

  // Internal guard to prevent overlapping mixes
  mixInProgress: boolean;

  // UI hint when tempo matching is disabled for a transition.
  lastTransitionTempoMatchDisabled: boolean;
  lastTransitionTempoMatchRequiredPct: number | null;
  lastTransitionTempoMatchCeilingPct: number | null;

  // Debuggable snapshot of the last transition tempo plan.
  lastTransitionTempoPlan: {
    mode: 'party' | 'autoMatch' | 'locked' | 'preset' | 'original';
    nextBaseBpmUsed: number | null;
    outgoingBaseBpmUsed: number | null;
    targetBpmUsed: number | null;
    targetBpm: number | null;
    outgoingTargetRatio: number;
    incomingTargetRatio: number;
    requiredIncomingPercent: number | null;
    requiredOutgoingPercent: number | null;
    requiredPercent: number | null;
    capPctUsed: number | null;
    overCap: boolean | null;
    tempoMatchDisabled: boolean;
    disabledReason: 'over_cap' | 'missing_bpm' | 'user_disabled' | null;
    possibleHalfDouble: boolean;
    altTargetBpm: number | null;
    postTransitionPolicy: 'hold' | 'revert' | 'neutralTo1.0';
    rampStartAt: number | null;
    rampEndAt: number | null;
    rampSecWanted: number | null;
    rampSecActual: number | null;
    quantizedTo: '16bar' | '8bar' | '4bar' | '1bar' | null;
  } | null;

  // Debug snapshot of the most recent tempo calculation we applied.
  lastTempoDebug: {
    deck: DeckId;
    trackBpm: number | null;
    targetBpm: number | null;
    rawRate: number | null;
    clampedRate: number | null;
    effectiveBpm: number | null;
    maxTempoPercent: number | null;
  } | null;

  // Actions
  loadTracks: () => Promise<void>;
  loadPlaylists: () => Promise<void>;
  loadSettings: () => Promise<void>;
  importTracks: (files: FileList) => Promise<void>;
  clearAllImports: () => Promise<void>;
  deleteTrackById: (id: string) => Promise<void>;

  // Starter packs
  seedStarterTracksIfEmpty: (packIds: string[]) => Promise<boolean>;
  downloadStarterPacks: (packIds: string[]) => Promise<{added: number; skipped: number}>;
  removeStarterTracks: () => Promise<number>;

  // Removal semantics (Library / Playlist / Current Source)
  removeFromLibrary: (trackId: string, opts?: {reason?: 'user' | 'sync'}) => Promise<void>;
  removeFromPlaylist: (playlistId: string, trackId: string, opts?: {emit?: boolean}) => Promise<void>;
  removeFromCurrentSource: (trackId: string, opts?: {emit?: boolean}) => Promise<void>;

  // Playback
  loadTrackToDeck: (trackId: string, deck: DeckId, offsetSeconds?: number) => Promise<void>;
  play: (deck?: DeckId) => void;
  pause: (deck?: DeckId) => void;
  togglePlayPause: (deck?: DeckId) => void;
  seek: (deck: DeckId, time: number) => void;
  restartCurrentTrack: (arg?: DeckId | { deck?: DeckId; reason?: string; silent?: boolean }) => void;
  smartBack: (deck?: DeckId) => void;
  playPreviousTrack: (deck?: DeckId) => Promise<void>;
  skip: (reason?: 'user' | 'auto' | 'end' | 'switch') => void;

  // Party mode
  startPartyMode: (source: PartySource) => Promise<void>;
  stopPartyMode: () => void;
  triggerMixNow: () => void;
  setPartySource: (source: PartySource | null) => void;
  switchPartySourceSmooth: (source: PartySource) => Promise<void>;
  saveCurrentPartyAsPlaylist: (name: string) => Promise<string | null>;

  // Queue management (playlist-based)
  moveTrackInParty: (fromIndex: number, toIndex: number) => void;
  playNow: (index: number) => void;
  playNext: (index: number) => void;
  shufflePartyTracks: () => void;
  restartPlaylist: () => void;

  // Mixing
  setCrossfade: (value: number) => void;
  setTempo: (deck: DeckId, ratio: number) => void;

  // Utility: force the engine to match current tempo settings (and feature gating).
  syncTempoNow: (opts?: { reason?: string }) => void;

  // Master output
  setMasterVolume: (value: number) => void;

  // Settings
  updateUserSettings: (updates: Partial<Settings>) => Promise<void>;

  // Local data reset
  resetLocalData: () => Promise<void>;

  // Playlists
  createPlaylist: (name: string) => Promise<void>;
  addTrackToPlaylist: (playlistId: string, trackId: string) => Promise<void>;
  removeTrackFromPlaylist: (playlistId: string, trackId: string) => Promise<void>;
  clearPlaylistTracks: (playlistId: string) => Promise<void>;
  reorderPlaylistTracks: (playlistId: string, fromIndex: number, toIndex: number) => Promise<void>;
  deletePlaylistById: (id: string) => Promise<void>;

  // Helper to get current party tracks
  getPartyTracks: () => Track[];
  getCurrentTrack: () => Track | undefined;
  getUpcomingTracks: () => Track[];
}

const initialDeckState: DeckState = {
  trackId: null,
  currentTime: 0,
  duration: 0,
  isPlaying: false,
  playbackRate: 1,
};

const getDjSessionStorage = () => {
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
};

const djStoreNoopStorage = {
  getItem: (_name: string) => null,
  setItem: (_name: string, _value: string) => {
    // noop
  },
  removeItem: (_name: string) => {
    // noop
  },
};

export const useDJStore = create<DJState>()(
  persist(
    (set, get) => {
  let scheduledTimeouts: Array<ReturnType<typeof setTimeout>> = [];
  let masterVolumeSaveTimeout: ReturnType<typeof setTimeout> | null = null;
  let settingsSaveTimeout: ReturnType<typeof setTimeout> | null = null;
  let queuedSettingsUpdates: Partial<Settings> = {};

  // Guard against repeated seed attempts within a single document lifetime.
  let didAttemptStarterSeedThisSession = false;

  // Grace period after restart - blocks all auto-mix triggers for 5 seconds
  let restartGraceUntilMs: number = 0;

  const FREE_UPLOAD_LIMIT_SECONDS = 30 * 60;
  // Allow a little overage for a single additional track.
  const FREE_UPLOAD_OVERAGE_MAX_SECONDS = 8 * 60;

  const clearScheduledTimeouts = () => {
    for (const id of scheduledTimeouts) {
      clearTimeout(id);
    }
    scheduledTimeouts = [];
  };

  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

  const computeTempoForDeck = (
    deck: DeckId,
    targetBpm: number,
    maxTempoPercent: number
  ): { ratio: number; debug: DJState['lastTempoDebug'] } => {
    const baseBpm = audioEngine.getBaseBpm(deck);
    const result = computeClampedTempoRatio({
      baseBpm,
      targetBpm,
      maxTempoPercent,
      minRatioFloor: 0.25,
      maxRatioCeil: 4,
    });

    const ratio = result.clampedRatio;
    const trackBpm = Number.isFinite(result.interpretedBaseBpm) && result.interpretedBaseBpm > 0 ? result.interpretedBaseBpm : null;
    const effectiveBpm = trackBpm !== null ? trackBpm * ratio : null;

    return {
      ratio,
      debug: {
        deck,
        trackBpm,
        targetBpm: Number.isFinite(targetBpm) && targetBpm > 0 ? targetBpm : null,
        rawRate: Number.isFinite(result.rawRatio) ? result.rawRatio : null,
        clampedRate: Number.isFinite(result.clampedRatio) ? result.clampedRatio : null,
        effectiveBpm,
        maxTempoPercent: Number.isFinite(maxTempoPercent) ? maxTempoPercent : null,
      },
    };
  };

  // Tempo ramp timing should feel tied to the crossfade window.
  // Default: ramp spans a lead-in plus the crossfade and finishes at the crossfade end.
  const computeTempoRampSecFromCrossfade = (crossfadeSec: number): number => {
    const x = clamp(Number.isFinite(crossfadeSec) ? crossfadeSec : 8, 1, 20);
    return clamp(x * 2, 4, 20);
  };

  const barsToBeats = (bars: number) => Math.max(1, Math.round(bars)) * 4;

  const quantizeNextUpTo = (
    deck: DeckId,
    fromTime: number,
    beatMultiples: number[],
    playbackRateOverride: number | undefined,
    latestAllowedTime: number
  ): number => {
    for (const beats of beatMultiples) {
      const t = audioEngine.getNextBeatTimeFrom(deck, fromTime, beats, playbackRateOverride) ?? fromTime;
      if (t <= latestAllowedTime + 1e-6) return t;
    }
    return Math.min(latestAllowedTime, audioEngine.getNextBeatTimeFrom(deck, fromTime, beatMultiples[beatMultiples.length - 1] ?? 4, playbackRateOverride) ?? fromTime);
  };

  const quantizeNextUpToWithInfo = (
    deck: DeckId,
    fromTime: number,
    beatMultiples: number[],
    playbackRateOverride: number | undefined,
    latestAllowedTime: number
  ): { time: number; beatMultipleUsed: number } => {
    for (const beats of beatMultiples) {
      const t = audioEngine.getNextBeatTimeFrom(deck, fromTime, beats, playbackRateOverride) ?? fromTime;
      if (t <= latestAllowedTime + 1e-6) return { time: t, beatMultipleUsed: beats };
    }
    const fallbackBeats = beatMultiples[beatMultiples.length - 1] ?? 4;
    const t = Math.min(
      latestAllowedTime,
      audioEngine.getNextBeatTimeFrom(deck, fromTime, fallbackBeats, playbackRateOverride) ?? fromTime
    );
    return { time: t, beatMultipleUsed: fallbackBeats };
  };

  const beatMultipleToQuantizedLabel = (beats: number): '16bar' | '8bar' | '4bar' | '1bar' => {
    const b = Math.max(1, Math.round(beats));
    if (b >= barsToBeats(16)) return '16bar';
    if (b >= barsToBeats(8)) return '8bar';
    if (b >= barsToBeats(4)) return '4bar';
    return '1bar';
  };

  const chooseBeatAlignedTimeInRange = (
    deck: DeckId,
    idealTime: number,
    beatMultiple: number,
    minTime: number,
    maxTime: number,
    playbackRateOverride: number | undefined
  ): number => {
    // Prefer snapping EARLIER (prev) so we don't start late,
    // but keep it inside the allowed window.
    const inRange = (t: number | null) => t !== null && t >= minTime - 1e-6 && t <= maxTime + 1e-6;

    const prev = audioEngine.getPrevBeatTimeFrom(deck, idealTime, beatMultiple, playbackRateOverride);
    if (inRange(prev)) return prev as number;

    // If prev is too early, try the next boundary at/after the window start.
    const nextFromMin = audioEngine.getNextBeatTimeFrom(deck, minTime, beatMultiple, playbackRateOverride);
    if (inRange(nextFromMin)) return nextFromMin as number;

    // Last resort: clamp. (Should be rare; mainly protects against missing context time.)
    return clamp(idealTime, minTime, maxTime);
  };

  const shuffleArray = <T,>(items: T[]): T[] => {
    const arr = [...items];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };

  const pushHistory = (history: string[], trackId: string | null | undefined): string[] => {
    if (!trackId) return history;
    const last = history[history.length - 1];
    if (last === trackId) return history;
    return [...history, trackId];
  };

  const resetTempoToNormal = () => {
    try {
      audioEngine.setTempo('A', 1);
      audioEngine.setTempo('B', 1);
    } catch {
      // ignore
    }

    set((state) => ({
      deckA: {...state.deckA, playbackRate: 1},
      deckB: {...state.deckB, playbackRate: 1},
    }));
  };
  // Preset mode is intentionally more expressive than Auto/Locked.
  // Auto is capped for safety; presets should be able to reach their targets.
  const PRESET_MAX_TEMPO_PERCENT = 35;

  const getEffectiveMaxTempoPercent = (settings: Settings): number => {
    if (settings.tempoMode === 'preset') return PRESET_MAX_TEMPO_PERCENT;
    return settings.maxTempoPercent;
  };

  // If the plan becomes Free, don't leave pitch/tempo altered.
  if (typeof window !== 'undefined') {
    try {
      let lastPlan = usePlanStore.getState().plan;
      usePlanStore.subscribe((s) => {
        const plan = s.plan;
        if (plan === 'free' && lastPlan !== 'free') {
          resetTempoToNormal();
        }
        lastPlan = plan;
      });

      if (usePlanStore.getState().plan === 'free') {
        resetTempoToNormal();
      }
    } catch {
      // ignore
    }
  }

  const lockTolerancePctToAllowedDriftBpm = (pctRaw: number | undefined | null, targetBpm: number): number => {
    const pct = clamp(Number.isFinite(pctRaw as number) ? (pctRaw as number) : 10, 0, 100);
    if (!Number.isFinite(targetBpm) || targetBpm <= 0) return 0;
    if (pct >= 100) return Number.POSITIVE_INFINITY;
    return (pct / 100) * targetBpm;
  };

  const lastLockCorrectionAtCtx: Record<DeckId, number> = { A: -Infinity, B: -Infinity };
  const lastManualTempoChangeAtCtx: Record<DeckId, number> = { A: -Infinity, B: -Infinity };
  const maybeCorrectTempoLockDrift = (deck: DeckId) => {
    if (!usePlanStore.getState().hasFeature('tempoControl')) return;
    const state = get();
    if (state.settings.tempoMode !== 'locked') return;
    if (!audioEngine.isPlaying(deck)) return;

    const ctxNow = audioEngine.getAudioContextTime();
    if (ctxNow === null) return;

    // Don't fight explicit user actions (e.g. BPM slider moves).
    if (ctxNow - lastManualTempoChangeAtCtx[deck] < 2.0) return;

    // Don't fight scheduled ramps (mixing, user actions, etc).
    if (audioEngine.isTempoRamping(deck, ctxNow)) return;

    // Throttle corrections.
    if (ctxNow - lastLockCorrectionAtCtx[deck] < 0.75) return;

    const targetBpm = state.settings.lockedBpm;
    if (!Number.isFinite(targetBpm) || targetBpm <= 0) return;

    const baseBpm = audioEngine.getBaseBpm(deck) || 120;
    const effectiveRate = Math.max(0.25, audioEngine.getEffectiveTempo(deck, ctxNow) || 1);
    const currentBpm = baseBpm * effectiveRate;

    const { ratio: targetRatio, debug } = computeTempoForDeck(deck, targetBpm, getEffectiveMaxTempoPercent(state.settings));
    const targetEffectiveBpm = baseBpm * targetRatio;

    const allowedDrift = lockTolerancePctToAllowedDriftBpm(state.settings.lockTolerancePct, targetEffectiveBpm);
    const drift = Math.abs(currentBpm - targetEffectiveBpm);
    if (drift <= allowedDrift) return;

    // Bar-align when possible (4 beats); start slightly in the future for scheduling safety.
    const startCandidate = ctxNow + 0.05;
    const startAt = audioEngine.getNextBeatTimeFrom(deck, startCandidate, 4, effectiveRate) ?? startCandidate;

    // Smooth correction: scale ramp time with how far outside tolerance we are.
    const deltaOutside = Math.max(0, drift - allowedDrift);
    const durationMs = clamp(400 + deltaOutside * 500, state.settings.lockTolerancePct <= 0 ? 150 : 400, 3000);

    lastLockCorrectionAtCtx[deck] = ctxNow;
    set({ lastTempoDebug: debug });
    audioEngine.rampTempo(deck, targetRatio, startAt, durationMs);
  };

  const stopDeckIfTrackMatches = (trackId: string) => {
    const state = get();
    const toStop: DeckId[] = [];
    if (state.deckA.trackId === trackId) toStop.push('A');
    if (state.deckB.trackId === trackId) toStop.push('B');

    for (const deck of toStop) {
      try {
        audioEngine.pause(deck);
      } catch {
        // ignore
      }

      if (deck === 'A') {
        set(s => ({ deckA: { ...initialDeckState, playbackRate: s.deckA.playbackRate } }));
      } else {
        set(s => ({ deckB: { ...initialDeckState, playbackRate: s.deckB.playbackRate } }));
      }
    }
  };

  const computeQueueAfterRemoval = (state: DJState, trackId: string) => {
    if (!state.isPartyMode || state.partyTrackIds.length === 0) return null;

    const activeDeckState = state.activeDeck === 'A' ? state.deckA : state.deckB;
    const isCurrent = !!activeDeckState.trackId && activeDeckState.trackId === trackId && activeDeckState.isPlaying;

    const oldIds = state.partyTrackIds;
    const oldNow = state.nowPlayingIndex;
    const removedBefore = oldIds.slice(0, oldNow).filter(id => id === trackId).length;
    const nextIds = oldIds.filter(id => id !== trackId);

    let nextNow = Math.max(0, oldNow - removedBefore);
    if (nextIds.length === 0) {
      return { nextIds, nextNow: 0, shouldAdvance: isCurrent };
    }

    if (isCurrent) {
      if (nextNow >= nextIds.length) nextNow = 0;
      return { nextIds, nextNow, shouldAdvance: true };
    }

    if (nextNow >= nextIds.length) nextNow = Math.max(0, nextIds.length - 1);
    return { nextIds, nextNow, shouldAdvance: false };
  };

  const jumpToQueueIndex = async (index: number) => {
    const state = get();
    if (!state.isPartyMode) return;

    const trackId = state.partyTrackIds[index];
    if (!trackId) {
      get().stopPartyMode();
      return;
    }

    const track = state.tracks.find(t => t.id === trackId);
    if (!track?.fileBlob) {
      get().stopPartyMode();
      return;
    }

    clearScheduledTimeouts();
    try {
      audioEngine.enableMixCheck(false);
    } catch {
      // ignore
    }

    // Hard stop both decks to prevent "stuck playing" when deleting current track.
    try {
      audioEngine.stop('A');
      audioEngine.stop('B');
    } catch {
      // ignore
    }

    set({
      mixInProgress: false,
      pendingNextIndex: null,
      nowPlayingIndex: index,
      activeDeck: 'A',
      crossfadeValue: 0,
    });

    try {
      audioEngine.setCrossfade(0);
    } catch {
      // ignore
    }

    const startAt = getEffectiveStartTimeSec(track, get().settings);
    await get().loadTrackToDeck(trackId, 'A', startAt);
    get().play('A');

    // Restore automix trigger.
    const after = get();
    armAutoMixTriggerForState(after);
  };

  const getEffectiveStartTimeSec = (track: Track | undefined, settings: Settings | undefined) => {
    const base = (settings?.nextSongStartOffset ?? 0);
    const duration = track?.duration;
    if (!duration || !Number.isFinite(duration)) return Math.max(0, base);
    return clamp(base, 0, Math.max(0, duration - 0.25));
  };

  const getDeckState = (state: DJState, deck: DeckId) => (deck === 'A' ? state.deckA : state.deckB);

  const getDeckTrack = (state: DJState, deck: DeckId) => {
    const deckState = getDeckState(state, deck);
    return deckState.trackId ? state.tracks.find(t => t.id === deckState.trackId) : undefined;
  };

  const getDeckCurrentTime = (state: DJState, deck: DeckId) => {
    return audioEngine.getCurrentTime(deck) || getDeckState(state, deck).currentTime || 0;
  };

  const cancelPendingTransition = (arg?: { mixInProgress?: boolean; reason?: string } | string) => {
    const opts = typeof arg === 'string' ? { reason: arg } : arg;

    if (import.meta.env.DEV && opts?.reason) {
      console.debug('[DJ Store] cancelPendingTransition:', opts.reason);
    }

    // Cancels any scheduled transition timeouts (state updates, pause/stop hooks, etc).
    clearScheduledTimeouts();

    // Cancel any scheduled mix trigger from firing while we change state.
    try {
      audioEngine.enableMixCheck(false);
      audioEngine.resetMixTrigger();
    } catch {
      // ignore
    }

    // If a previous transition scheduled `sourceNode.stop(atTime)`, the only reliable way to
    // cancel it is to replace the underlying source nodes. Seeking to the current time forces
    // a pause/play cycle (new source node) without changing position.
    try {
      for (const deck of ['A', 'B'] as DeckId[]) {
        if (audioEngine.isPlaying(deck)) {
          const t = audioEngine.getCurrentTime(deck);
          audioEngine.seek(deck, t);
        }
      }
    } catch {
      // ignore
    }

    set({
      pendingNextIndex: null,
      pendingSourceSwitch: null,
      queuedSourceSwitch: null,
      mixInProgress: opts?.mixInProgress ?? false,
    });

    // Re-anchor crossfade to whichever deck we believe is active.
    try {
      const active = get().activeDeck;
      audioEngine.setCrossfade(active === 'A' ? 0 : 1);
    } catch {
      // ignore
    }
  };

  const defaultSettings: Settings = {
    crossfadeSeconds: 8,
    // Tempo stretch safety rails (percent away from 1.0×).
    // Default 8%; hard cap enforced elsewhere.
    maxTempoPercent: 8,
    shuffleEnabled: false,
    keepImportsOnDevice: true,
    prevBehavior: 'alwaysMixPrevious',
    masterVolume: 0.9,
    nextSongStartOffset: 15,
    endEarlySeconds: 5,
    tempoUiMode: 'vibes',
    lastAdvancedTempoMode: 'auto',
    tempoMode: 'preset',
    tempoPreset: 'original',
    lockedBpm: 128,
    lockTolerancePct: 10,
    autoBaseBpm: null,
    autoOffsetBpm: 0,
    partyTempoAfterTransition: 'hold',
    autoVolumeMatch: true,
    targetLoudness: 0.7,
    limiterEnabled: true,
    limiterStrength: 'medium',
    vibesPreset: 'flat',
    repeatMode: 'playlist',
  };

  const seedValentine2026StarterTracksIfEmpty = async (): Promise<boolean> => {
    if (didAttemptStarterSeedThisSession) return false;
    didAttemptStarterSeedThisSession = true;

    // Only seed when the library is truly empty.
    // We check IndexedDB directly so this stays correct even if the in-memory
    // store hasn't finished loading yet.
    try {
      const existing = await getAllTracks();
      if (existing.length > 0) return false;
    } catch {
      // If IDB is unavailable, fall back to in-memory check.
      if (get().tracks.length > 0) return false;
    }

    // Fetch starter MP3s from /public and store them as blobs like normal imports.
    const seeded: Track[] = [];

    for (const starter of valentine2026Pack) {
      try {
        const response = await fetch(starter.url);
        if (!response.ok) {
          throw new Error(`Failed to fetch starter track: ${starter.url} (${response.status})`);
        }

        const blob = await response.blob();

        let duration = 240;
        let bpm: number | undefined;
        let hasBeat = false;
        let trueEndTime: number | undefined;
        let loudnessDb: number | undefined;
        let gainDb: number | undefined;
        let analysisStatus: Track['analysisStatus'] = 'basic';

        try {
          const audioContext = new AudioContext();
          const arrayBuffer = await blob.arrayBuffer();
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
          duration = audioBuffer.duration || duration;

          try {
            const bpmResult = await detectBPM(audioBuffer);
            bpm = bpmResult.bpm;
            hasBeat = bpmResult.confidence > 0.3 && bpmResult.bpm > 0;
          } catch (e) {
            console.error('[DJ Store] Starter BPM analysis failed:', e);
          }

          try {
            trueEndTime = detectTrueEndTime(audioBuffer, {
              silenceThresholdDb: -60,
              minSilenceMs: 1000,
              minCutBeforeEndSec: 2.0,
            });
          } catch (e) {
            console.error('[DJ Store] Starter true-end analysis failed:', e);
          }

          try {
            const settings = get().settings;
            if (settings.autoVolumeMatch) {
              loudnessDb = audioEngine.measureLoudness(audioBuffer);
              const targetDb = -20 + (settings.targetLoudness * 12);
              gainDb = audioEngine.calculateGain(loudnessDb, targetDb);
            }
          } catch (e) {
            console.error('[DJ Store] Starter loudness analysis failed:', e);
          }

          try {
            audioContext.close();
          } catch {
            // ignore
          }

          analysisStatus = (hasBeat ? 'ready' : 'basic') as 'ready' | 'basic';
        } catch (e) {
          console.error('[DJ Store] Starter decode failed:', e);
        }

        const track: Track = {
          id: starter.id,
          localPath: starter.url,
          displayName: starter.title,
          artist: starter.artist,
          isStarter: true,
          duration,
          bpm,
          hasBeat,
          analysisStatus,
          fileBlob: blob,
          addedAt: Date.now(),
          trueEndTime,
          loudnessDb,
          gainDb,
        };

        // Starter tracks should be available offline once fetched.
        try {
          await addTrack(track);
        } catch (e) {
          console.error('[DJ Store] Failed to persist starter track to IndexedDB:', e);
          // Still seed into in-memory state so user can play this session.
        }

        seeded.push(track);
      } catch (e) {
        console.error('[DJ Store] Failed to seed starter track:', starter?.url, e);
      }
    }

    if (seeded.length === 0) return false;

    // Ensure in-memory state immediately reflects seeded tracks,
    // even if IndexedDB persistence fails.
    set(state => ({
      tracks: state.tracks.length === 0 ? seeded : state.tracks,
    }));

    return true;
  };

  const getCanonicalTargetBpm = (settings: Settings): number | null => {
    if (settings.tempoMode === 'locked') {
      return Number.isFinite(settings.lockedBpm) && settings.lockedBpm > 0 ? settings.lockedBpm : null;
    }
    if (settings.tempoMode === 'auto') {
      if (settings.autoBaseBpm === null || !Number.isFinite(settings.autoBaseBpm) || settings.autoBaseBpm <= 0) return null;
      // Auto Match uses a direct target BPM (single source of truth).
      // `autoOffsetBpm` remains for back-compat in persisted settings but is ignored.
      return settings.autoBaseBpm;
    }
    // Preset mode uses relative ratios, not absolute BPM targets.
    // Return null to signal "no global target BPM".
    return null;
  };

  const computeAutoMixTriggerSecondsTrack = (state: DJState) => {
    const outgoingDeck = state.activeDeck;
    const outgoingDeckState = outgoingDeck === 'A' ? state.deckA : state.deckB;
    const outgoingTrack = state.tracks.find(t => t.id === outgoingDeckState.trackId);

    let nextTrackBpm: number | undefined;
    if (!state.settings.shuffleEnabled) {
      const nextIndex = state.pendingNextIndex ?? state.nowPlayingIndex + 1;
      const nextTrackId = state.partyTrackIds[nextIndex];
      const nextTrack = nextTrackId ? state.tracks.find(t => t.id === nextTrackId) : undefined;
      nextTrackBpm = nextTrack?.bpm;
    }

    const endEarlySeconds = clamp(state.settings.endEarlySeconds ?? 0, 0, 60);
    const effectiveCrossfadeSeconds = clamp(state.settings.crossfadeSeconds ?? 8, 1, 20);

    // Fixed "normal" profile for quantization/settle math.
    const energy = {
      startQuantBeats: 1,
      fadeQuantBeats: 1,
      settleBeats: 2,
      stepLargeDeltas: false,
    };

    const outgoingRate = Math.max(0.25, audioEngine.getTempo(outgoingDeck) || 1);

    const fallbackBpm = (outgoingTrack?.bpm ?? audioEngine.getBaseBpm(outgoingDeck) ?? 120) * outgoingRate;
    const tempoControlEnabled = usePlanStore.getState().hasFeature('tempoControl');
    const targetBpm = tempoControlEnabled
      ? (getCanonicalTargetBpm(state.settings) ?? fallbackBpm)
      : fallbackBpm;

    const beatSec = 60 / Math.max(1, targetBpm);
    const barSec = beatSec * 4;

    // Tempo ramp + settle + quantization window (worst-case) - in REAL seconds.
    const rampSec = computeTempoRampSecFromCrossfade(effectiveCrossfadeSeconds);
    const settleSec = beatSec * energy.settleBeats;
    // Phrase-aware quantization window: we may align to 4/8/16 bars depending on timing.
    // Use a conservative worst-case so auto-mix triggers early enough.
    const maxPhraseBars = effectiveCrossfadeSeconds >= 10 ? 16 : 8;
    const quantWindowSec = barSec * maxPhraseBars;

    // Chill 2-step can include an extra 1-bar wait.
    const bpmDelta = Math.abs((outgoingTrack?.bpm ?? 120) - targetBpm);
    const twoStepExtraSec = energy.stepLargeDeltas && bpmDelta > 6 ? barSec + rampSec : 0;

    const desiredRealSeconds = endEarlySeconds + effectiveCrossfadeSeconds + rampSec + settleSec + quantWindowSec + twoStepExtraSec;
    // Convert from real seconds to track-time seconds for the engine's "remaining" trigger.
    // Engine trigger compares against *track-time* remaining; convert from real seconds.
    return desiredRealSeconds * outgoingRate;
  };

  // Auto-mix trigger guardrails:
  // If the threshold is larger than the track's effective length, the engine triggers immediately.
  // Ensure the user always gets a small minimum play window before auto-mix can fire.
  const MIN_AUTOMIX_PLAY_WINDOW_REAL_SEC = 5;

  const armAutoMixTriggerForState = (state: DJState) => {
    if (!state.isPartyMode) return;

    if (state.settings.repeatMode === 'track') {
      audioEngine.enableMixCheck(false);
      audioEngine.resetMixTrigger();
      return;
    }

    const outgoingDeck = state.activeDeck;
    const outgoingDeckState = getDeckState(state, outgoingDeck);
    const durationTrack = audioEngine.getDuration(outgoingDeck) || outgoingDeckState.duration || 0;
    const rate = Math.max(0.25, audioEngine.getTempo(outgoingDeck) || outgoingDeckState.playbackRate || 1);

    const wantedSecondsTrack = computeAutoMixTriggerSecondsTrack(state);

    // Ensure at least MIN_AUTOMIX_PLAY_WINDOW_REAL_SEC of real playback before auto-mix can trigger.
    const maxSecondsTrack = Math.max(0, durationTrack - (MIN_AUTOMIX_PLAY_WINDOW_REAL_SEC * rate));
    const safeSecondsTrack = Math.max(0, Math.min(wantedSecondsTrack, maxSecondsTrack));

    audioEngine.setMixTriggerConfig('remaining', safeSecondsTrack);
    audioEngine.enableMixCheck(safeSecondsTrack > 0);
    audioEngine.resetMixTrigger();
  };

  const applyImmediateTempoToDeck = (state: DJState, deck: DeckId) => {
    if (!usePlanStore.getState().hasFeature('tempoControl')) return;
    const deckState = deck === 'A' ? state.deckA : state.deckB;
    if (!deckState.trackId) return;

    const targetBpm = getCanonicalTargetBpm(state.settings);
    if (targetBpm === null) {
      // Preset "Original": explicitly restore neutral speed.
    // Preset mode: use relative ratio based on track's original BPM
    if (state.settings.tempoMode === 'preset') {
      const track = state.tracks.find(t => t.id === deckState.trackId);
      const preset = state.settings.tempoPreset ?? 'original';
      const result = computePresetTempo(track?.bpm, preset);

      const ctxNow = audioEngine.getAudioContextTime();
      if (ctxNow !== null) {
        lastManualTempoChangeAtCtx[deck] = ctxNow;
      }

      get().setTempo(deck, result.ratio);
      return;
    }

    // Locked/Auto modes: compute ratio from absolute target BPM
    const targetBpm = getCanonicalTargetBpm(state.settings);
    if (targetBpm === null) {
      // No valid target in locked/auto mode - fall back to neutral
      }
      get().setTempo(deck, 1);
      return;
    }

    const { ratio, debug } = computeTempoForDeck(deck, targetBpm, getEffectiveMaxTempoPercent(state.settings));
    const ctxNow = audioEngine.getAudioContextTime();
    if (ctxNow !== null) {
      lastManualTempoChangeAtCtx[deck] = ctxNow;
    }
    set({ lastTempoDebug: debug });
    get().setTempo(deck, ratio);
  };

  const ensureGainDbForTrack = async (track: Track, settings: Settings): Promise<number | undefined> => {
    if (!settings.autoVolumeMatch) return undefined;
    if (typeof track.gainDb === 'number' && Number.isFinite(track.gainDb)) return track.gainDb;
    if (!track.fileBlob) return undefined;

    try {
      const loudnessResult = await audioEngine.analyzeLoudness(track.fileBlob);
      // Per-track normalization target.
      // Baseline -14 dB (streaming-ish), adjusted by user preference.
      const targetDb = -14 + ((settings.targetLoudness - 0.5) * 12);
      const gainDb = audioEngine.calculateGain(loudnessResult.loudnessDb, targetDb);
      const updates = { loudnessDb: loudnessResult.loudnessDb, gainDb };
      await updateTrack(track.id, updates);
      set((s) => ({
        tracks: s.tracks.map((t) => (t.id === track.id ? { ...t, ...updates } : t)),
      }));
      return gainDb;
    } catch {
      return undefined;
    }
  };

  const applyImmediateTempoToPlayingDecks = (state: DJState) => {
    const playing: DeckId[] = [];
    try {
      if (audioEngine.isPlaying('A')) playing.push('A');
      if (audioEngine.isPlaying('B')) playing.push('B');
    } catch {
      // ignore
    }

    if (playing.length === 0) {
      applyImmediateTempoToDeck(state, state.activeDeck);
      return;
    }

    for (const deck of playing) {
      applyImmediateTempoToDeck(state, deck);
    }
  };

  const syncTempoNowImpl = (state: DJState) => {
    const tempoControlEnabled = usePlanStore.getState().hasFeature('tempoControl');
    if (!tempoControlEnabled) {
      // If tempo control is not entitled, force neutral speed.
      try {
        get().setTempo('A', 1);
        get().setTempo('B', 1);
      } catch {
        // ignore
      }
      return;
    }

    applyImmediateTempoToPlayingDecks(state);
  };

  const getTrackIdsForPartySource = (state: DJState, source: PartySource): string[] => {
    if (source.type === 'import') {
      return state.tracks.filter(t => t.fileBlob).map(t => t.id);
    }

    if (source.type === 'playlist' && source.playlistId) {
      const playlist = state.playlists.find(p => p.id === source.playlistId);
      return (playlist?.trackIds || []).filter(id => {
        const track = state.tracks.find(t => t.id === id);
        return track?.fileBlob;
      });
    }

    return [];
  };

  // Set up audio engine callbacks
  audioEngine.setOnTimeUpdate((deck, time) => {
    // Keep playbackRate in sync even when the engine is ramping tempo.
    // (The store's playbackRate is used for UI BPM display.)
    try {
      const effectiveRate = audioEngine.getEffectiveTempo(deck);
      const prevRate = deck === 'A' ? get().deckA.playbackRate : get().deckB.playbackRate;
      if (Math.abs(effectiveRate - prevRate) > 0.001) {
        if (deck === 'A') {
          set(state => ({ deckA: { ...state.deckA, playbackRate: effectiveRate } }));
        } else {
          set(state => ({ deckB: { ...state.deckB, playbackRate: effectiveRate } }));
        }
      }
    } catch {
      // ignore
    }

    try {
      maybeCorrectTempoLockDrift(deck);
    } catch {
      // ignore
    }

    if (deck === 'A') {
      set(state => ({ deckA: { ...state.deckA, currentTime: time } }));
    } else {
      set(state => ({ deckB: { ...state.deckB, currentTime: time } }));
    }
  });

  audioEngine.setOnTrackEnd((deck) => {
    const state = get();
    if (state.isPartyMode) {
      if (state.settings.repeatMode === 'track') {
        get().restartCurrentTrack({ deck, reason: 'repeat_end', silent: true });
        return;
      }

      // Auto-advance to next track
      get().skip('end');
    } else {
      if (deck === 'A') {
        set(state => ({ deckA: { ...state.deckA, isPlaying: false, currentTime: 0 } }));
      } else {
        set(state => ({ deckB: { ...state.deckB, isPlaying: false, currentTime: 0 } }));
      }
    }
  });

  // Set up mix trigger callback for auto-mixing
  audioEngine.setOnMixTrigger(() => {
    // BLOCK if within grace period after restart
    if (Date.now() < restartGraceUntilMs) {
      audioEngine.resetMixTrigger();  // Reset so it can try again later
      return;
    }

    const state = get();
    if (state.isPartyMode) {
      if (state.settings.repeatMode === 'track') return;
      const hasMore = state.nowPlayingIndex < state.partyTrackIds.length - 1;
      const canLoop = state.settings.repeatMode === 'playlist';
      if (hasMore || canLoop) {
        get().skip('auto');
      }
    }
  });

  return {
    tracks: [],
    isLoadingTracks: true,
    playlists: [],
    deckA: { ...initialDeckState },
    deckB: { ...initialDeckState },
    activeDeck: 'A',
    isPartyMode: false,
    partySource: null,
    partyTrackIds: [],
    nowPlayingIndex: 0,
    pendingNextIndex: null,
    playHistoryTrackIds: [],
    pendingSourceSwitch: null,
    queuedSourceSwitch: null,
    settings: defaultSettings,
    crossfadeValue: 0,
    mixInProgress: false,
    lastTransitionTempoMatchDisabled: false,
    lastTransitionTempoMatchRequiredPct: null,
    lastTransitionTempoMatchCeilingPct: null,
    lastTransitionTempoPlan: null,
    lastTempoDebug: null,

    loadTracks: async () => {
      set({ isLoadingTracks: true });
      try {
        if (import.meta.env.DEV) {
          console.debug('[DJ Store] Loading tracks from IndexedDB...');
        }
        const tracks = await getAllTracks();
        if (import.meta.env.DEV) {
          console.debug('[DJ Store] Loaded tracks:', tracks.length);
        }
        set({ tracks, isLoadingTracks: false });
      } catch (error) {
        console.error('[DJ Store] Failed to load tracks:', error);
        set({ isLoadingTracks: false });
      }
    },

    seedStarterTracksIfEmpty: async (packIds: string[]) => {
      const ids = Array.isArray(packIds) ? packIds : [];
      if (ids.length === 0) return false;

      // Only one pack is implemented right now; keep the API future-proof.
      if (ids.includes('valentine-2026')) {
        const seeded = await seedValentine2026StarterTracksIfEmpty();
        if (seeded) {
          // Refresh state from IndexedDB when available.
          try {
            const tracks = await getAllTracks();
            set({ tracks });
          } catch {
            // ignore
          }
        }
        return seeded;
      }

      return false;
    },

    downloadStarterPacks: async (packIds: string[]) => {
      if (!packIds.length) return { added: 0, skipped: 0 };

      // Get tracks for selected packs
      const tracksToAdd: typeof valentine2026Pack = [];
      for (const packId of packIds) {
        if (packId === 'valentine-2026') {
          tracksToAdd.push(...valentine2026Pack);
        } else if (packId === 'party-pack') {
          tracksToAdd.push(...partyPack);
        }
      }

      if (tracksToAdd.length === 0) return { added: 0, skipped: 0 };

      // Get existing tracks to dedupe
      let existing: Track[] = [];
      try {
        existing = await getAllTracks();
      } catch {
        existing = get().tracks;
      }

      const existingKeys = new Set(existing.map(t => t.localPath || t.id));
      const newOnes = tracksToAdd.filter(t => !existingKeys.has(t.url));

      if (newOnes.length === 0) {
        return { added: 0, skipped: tracksToAdd.length };
      }

      // Download and process new tracks
      const seeded: Track[] = [];
      for (const starter of newOnes) {
        try {
          const response = await fetch(starter.url);
          if (!response.ok) continue;

          const blob = await response.blob();
          let duration = 240;
          let bpm: number | undefined;
          let hasBeat = false;
          let trueEndTime: number | undefined;
          let loudnessDb: number | undefined;
          let gainDb: number | undefined;
          let analysisStatus: Track['analysisStatus'] = 'basic';

          try {
            const audioContext = new AudioContext();
            const arrayBuffer = await blob.arrayBuffer();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            duration = audioBuffer.duration || duration;

            try {
              const bpmResult = await detectBPM(audioBuffer);
              bpm = bpmResult.bpm;
              hasBeat = bpmResult.confidence > 0.3 && bpmResult.bpm > 0;
            } catch (e) {
              console.error('[DJ Store] BPM analysis failed:', e);
            }

            try {
              trueEndTime = detectTrueEndTime(audioBuffer, {
                silenceThresholdDb: -60,
                minSilenceMs: 1000,
                minCutBeforeEndSec: 2.0,
              });
            } catch (e) {
              console.error('[DJ Store] True-end analysis failed:', e);
            }

            try {
              const settings = get().settings;
              if (settings.autoVolumeMatch) {
                loudnessDb = audioEngine.measureLoudness(audioBuffer);
                const targetDb = -20 + (settings.targetLoudness * 12);
                gainDb = audioEngine.calculateGain(loudnessDb, targetDb);
              }
            } catch (e) {
              console.error('[DJ Store] Loudness analysis failed:', e);
            }

            try {
              audioContext.close();
            } catch {
              // ignore
            }

            analysisStatus = (hasBeat ? 'ready' : 'basic') as 'ready' | 'basic';
          } catch (e) {
            console.error('[DJ Store] Decode failed:', e);
          }

          const track: Track = {
            id: starter.id,
            localPath: starter.url,
            displayName: starter.title,
            artist: starter.artist,
            isStarter: true,
            duration,
            bpm,
            hasBeat,
            analysisStatus,
            fileBlob: blob,
            addedAt: Date.now(),
            trueEndTime,
            loudnessDb,
            gainDb,
          };

          try {
            await addTrack(track);
          } catch (e) {
            console.error('[DJ Store] Failed to persist track:', e);
          }

          seeded.push(track);
        } catch (e) {
          console.error('[DJ Store] Failed to download track:', starter?.url, e);
        }
      }

      if (seeded.length > 0) {
        // Refresh from IndexedDB to get updated state
        try {
          const tracks = await getAllTracks();
          set({ tracks });
        } catch {
          // Fallback: update in-memory state
          set(state => ({
            tracks: [...seeded, ...state.tracks],
          }));
        }
      }

      return { added: seeded.length, skipped: tracksToAdd.length - newOnes.length };
    },

    removeStarterTracks: async () => {
      const starterTracks = get().tracks.filter(t => t.isStarter);
      if (starterTracks.length === 0) return 0;

      // Remove from IndexedDB
      for (const track of starterTracks) {
        try {
          await deleteTrack(track.id);
        } catch (e) {
          console.error('[DJ Store] Failed to delete starter track:', track.id, e);
        }
      }

      // Update state
      try {
        const tracks = await getAllTracks();
        set({ tracks });
      } catch {
        // Fallback: filter in-memory
        set(state => ({
          tracks: state.tracks.filter(t => !t.isStarter),
        }));
      }

      return starterTracks.length;
    },

    loadPlaylists: async () => {
      const playlists = await getAllPlaylists();
      set({ playlists });
    },

    loadSettings: async () => {
      const settings = await getSettings();

      // Preserve user's preset selection across reloads
      set({ settings });
      // Apply limiter settings
      audioEngine.setLimiterEnabled(settings.limiterEnabled);
      audioEngine.setLimiterStrength(settings.limiterStrength);
      audioEngine.setMasterVolume(settings.masterVolume ?? 0.9);
      audioEngine.setVibesPreset(settings.vibesPreset ?? 'flat', { ms: 0 });

      // Ensure the engine reflects the loaded settings immediately.
      try {
        get().syncTempoNow({ reason: 'loadSettings' });
      } catch {
        // ignore
      }
    },

    resetLocalData: async () => {
      // Stop playback + timers first.
      try {
        get().stopPartyMode();
      } catch {
        // ignore
      }
      clearScheduledTimeouts();

      try {
        audioEngine.destroy();
      } catch {
        // ignore
      }

      // Clear persistent storage.
      try {
        await resetLocalDatabase();
      } catch (error) {
        console.error('[DJ Store] Failed to reset local database:', error);
      }

      try {
        sessionStorage.removeItem('mejay:lastTab');
      } catch {
        // ignore
      }

      // Reset in-memory app state to a clean slate.
      set({
        tracks: [],
        isLoadingTracks: false,
        playlists: [],
        deckA: { ...initialDeckState },
        deckB: { ...initialDeckState },
        activeDeck: 'A',
        isPartyMode: false,
        partySource: null,
        partyTrackIds: [],
        nowPlayingIndex: 0,
        pendingNextIndex: null,
        pendingSourceSwitch: null,
        queuedSourceSwitch: null,
        crossfadeValue: 0,
        mixInProgress: false,
        lastTempoDebug: null,
        settings: defaultSettings,
      });
    },

    clearAllImports: async () => {
      // Stop party mode + playback first so we don't reference deleted tracks.
      try {
        get().stopPartyMode();
      } catch {
        // ignore
      }

      try {
        audioEngine.stop('A');
        audioEngine.stop('B');
      } catch {
        // ignore
      }

      try {
        await clearTracksAndPlaylists();
      } catch (error) {
        console.error('[DJ Store] Failed to clear imports:', error);
        toast({
          title: 'Clear failed',
          description: 'Could not clear your imports. Please try again.',
          variant: 'destructive',
        });
        return;
      }

      set({
        tracks: [],
        playlists: [],
        deckA: { ...initialDeckState },
        deckB: { ...initialDeckState },
        activeDeck: 'A',
        isPartyMode: false,
        partySource: null,
        partyTrackIds: [],
        nowPlayingIndex: 0,
        pendingNextIndex: null,
        pendingSourceSwitch: null,
        queuedSourceSwitch: null,
        crossfadeValue: 0,
        mixInProgress: false,
      });

      toast({
        title: 'Cleared',
        description: 'All imported tracks and playlists were removed.',
      });
    },

    importTracks: async (files: FileList) => {
      const supportedMimeTypes = new Set([
        'audio/mpeg',
        'audio/mp4',
        'audio/aac',
        'audio/wav',
        'audio/x-m4a',
        // Non-standard but seen in the wild (especially mobile browsers)
        'audio/mp3',
        'audio/x-mp3',
        'audio/x-mpeg',
        'audio/m4a',
      ]);

      const supportedExtensions = new Set(['mp3', 'm4a', 'aac', 'wav', 'mp4']);

      const isSupportedAudioFile = (file: File) => {
        const mime = (file.type || '').toLowerCase().trim();

        const name = (file.name || '').toLowerCase();
        const ext = name.includes('.') ? name.split('.').pop() : '';
        const hasSupportedExt = !!ext && supportedExtensions.has(ext);

        // Prefer extension checks first. On iOS, MIME can be empty or wrong.
        // Gmail attachments are often `application/octet-stream` even for MP3.
        if (hasSupportedExt) {
          if (!mime) return true;
          if (mime === 'application/octet-stream') return true;
          if (supportedMimeTypes.has(mime)) return true;
          if (mime.startsWith('audio/')) return true;
          // Some providers incorrectly label audio files as video/*.
          // Only allow video/* when the extension clearly indicates audio.
          if (mime.startsWith('video/')) return true;
          return false;
        }

        if (mime) {
          if (supportedMimeTypes.has(mime)) return true;
          // If browser reports a generic audio/* but not one of our exact types, still allow.
          if (mime.startsWith('audio/')) return true;
          // Some providers incorrectly label audio as octet-stream.
          if (mime === 'application/octet-stream') return true;
          return false;
        }

        // iOS Safari / Files can return an empty MIME type; fall back to extension.
        if (!ext) return false;
        return supportedExtensions.has(ext);
      };

      const planState = usePlanStore.getState();
      const isFree = planState.plan === 'free';

      if (!files || files.length === 0) return;

      const keepImportsOnDevice = get().settings.keepImportsOnDevice !== false;

      // Track total imported duration to enforce quota. (Only counts tracks with file blobs.)
      const computeLibrarySeconds = () => {
        const state = get();
        return state.tracks.reduce((sum, t) => sum + (t.fileBlob && !t.isStarter ? (t.duration || 0) : 0), 0);
      };

      let librarySeconds = isFree ? computeLibrarySeconds() : 0;
      let overageUsed = false;

      const showLimitToast = () => {
        toast({
          title: 'Free plan limit reached',
          description: 'Free mode supports ~30 minutes of imported music. Upgrade to Pro or Full Program to import more.',
          variant: 'destructive',
        });
        usePlanStore.getState().openUpgradeModal();
      };

      if (isFree && librarySeconds >= FREE_UPLOAD_LIMIT_SECONDS) {
        showLimitToast();
        return;
      }

      let importedCount = 0;
      let skippedUnsupportedCount = 0;
      let failedCount = 0;

      for (const file of Array.from(files)) {
        try {
          if (!isSupportedAudioFile(file)) {
            skippedUnsupportedCount += 1;
            continue;
          }

        const id = generateId();
        const track: Track = {
          id,
          localPath: file.name,
          displayName: file.name.replace(/\.[^/.]+$/, ''),
          duration: 0,
          bpm: undefined,
          hasBeat: false,
          analysisStatus: 'pending',
          fileBlob: file,
          addedAt: Date.now(),
        };

        // Try to get duration
        try {
          const audioContext = new AudioContext();
          const arrayBuffer = await file.arrayBuffer();
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
          track.duration = audioBuffer.duration;
          audioContext.close();
        } catch (e) {
          console.error('Failed to decode audio:', e);
          // Conservative estimate so duration-less imports can't bypass the quota.
          track.duration = 240;
        }

        if (isFree) {
          const wouldBe = librarySeconds + (track.duration || 0);
          const withinLimit = wouldBe <= FREE_UPLOAD_LIMIT_SECONDS;
          const withinOneTrackOverage = !overageUsed &&
            librarySeconds < FREE_UPLOAD_LIMIT_SECONDS &&
            wouldBe <= (FREE_UPLOAD_LIMIT_SECONDS + FREE_UPLOAD_OVERAGE_MAX_SECONDS);

          if (!withinLimit && !withinOneTrackOverage) {
            showLimitToast();
            break;
          }

          if (!withinLimit && withinOneTrackOverage) {
            overageUsed = true;
          }
        }

        if (keepImportsOnDevice) {
          try {
            await addTrack(track);
          } catch (e) {
            console.error('[DJ Store] Failed to persist imported track to IndexedDB:', e);
            // Fallback: still add to in-memory state so the user can play it in this session.
          }
        }

        importedCount += 1;
        set(state => {
          const nextTracks = [...state.tracks, track];

          // If Party Mode is currently running on the Import List, auto-append newly imported
          // tracks into the active party queue so they will play without restarting.
          if (state.isPartyMode && state.partySource?.type === 'import') {
            const alreadyQueued = state.partyTrackIds.includes(track.id);
            if (!alreadyQueued) {
              return {
                tracks: nextTracks,
                partyTrackIds: [...state.partyTrackIds, track.id],
              };
            }
          }

          return { tracks: nextTracks };
        });

        if (isFree) {
          librarySeconds += (track.duration || 0);
          if (librarySeconds >= FREE_UPLOAD_LIMIT_SECONDS && overageUsed) {
            // Stop after the allowed overage track.
            toast({
              title: 'Import limit reached',
              description: 'You have hit the Free mode import limit. Upgrade to add more tracks.',
            });
            usePlanStore.getState().openUpgradeModal();
            break;
          }
        }

        // Start BPM analysis in background
        set(state => ({
          tracks: state.tracks.map(t =>
            t.id === id ? { ...t, analysisStatus: 'analyzing' as const } : t
          ),
        }));

        try {
          const settings = get().settings;

          // Decode once and reuse the AudioBuffer for all analysis.
          const audioContext = new AudioContext();
          const arrayBuffer = await file.arrayBuffer();
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

          const bpmResult = await detectBPM(audioBuffer);
          const bpm = bpmResult.bpm;
          const hasBeat = bpmResult.confidence > 0.3 && bpmResult.bpm > 0;

          // Trailing-silence trimming (used for transition planning).
          let trueEndTime: number | undefined;
          try {
            trueEndTime = detectTrueEndTime(audioBuffer, {
              silenceThresholdDb: -60,  // More conservative: only truly silent sections
              minSilenceMs: 1000,        // Require 1 full second of silence
              minCutBeforeEndSec: 2.0,   // Don't cut within last 2 seconds
            });
          } catch (e) {
            console.error('True end time analysis failed:', e);
          }

          // Loudness analysis (optional)
          let loudnessDb: number | undefined;
          let gainDb: number | undefined;

          if (settings.autoVolumeMatch) {
            try {
              loudnessDb = audioEngine.measureLoudness(audioBuffer);
              // Adjust gain based on target loudness setting (0-1 scale)
              // targetLoudness 0 = -20dB, 1 = -8dB
              const targetDb = -20 + (settings.targetLoudness * 12);
              gainDb = audioEngine.calculateGain(loudnessDb, targetDb);
            } catch (e) {
              console.error('Loudness analysis failed:', e);
            }
          }

          try {
            audioContext.close();
          } catch {
            // ignore
          }

          const updates = {
            bpm,
            hasBeat,
            trueEndTime,
            analysisStatus: (hasBeat ? 'ready' : 'basic') as 'ready' | 'basic',
            loudnessDb,
            gainDb,
          };

          if (keepImportsOnDevice) {
            await updateTrack(id, updates);
          }
          set(state => ({
            tracks: state.tracks.map(t =>
              t.id === id ? { ...t, ...updates } : t
            ),
          }));

          // If this track is currently loaded on a deck, update the engine immediately.
          try {
            const sNow = get();
            if (sNow.deckA.trackId === id) audioEngine.setTrueEndTime('A', updates.trueEndTime);
            if (sNow.deckB.trackId === id) audioEngine.setTrueEndTime('B', updates.trueEndTime);
          } catch {
            // ignore
          }
        } catch (e) {
          console.error('BPM analysis failed:', e);
          if (keepImportsOnDevice) {
            await updateTrack(id, { analysisStatus: 'basic' });
          }
          set(state => ({
            tracks: state.tracks.map(t =>
              t.id === id ? { ...t, analysisStatus: 'basic' as const } : t
            ),
          }));
        }
        } catch (e) {
          failedCount += 1;
          console.error('[DJ Store] Import failed for file:', file?.name, e);
        }
      }

      if (importedCount === 0) {
        if (skippedUnsupportedCount > 0) {
          toast({
            title: 'No supported audio files',
            description: 'Those files were skipped. Try .mp3, .m4a, .aac, .wav, or .mp4 (audio).',
            variant: 'destructive',
          });
        }
        return;
      }

      const parts: string[] = [];
      if (skippedUnsupportedCount > 0) parts.push(`${skippedUnsupportedCount} skipped`);
      // failedCount includes IDB failures + per-file exceptions; keep it as a hint.
      if (failedCount > 0) parts.push(`${failedCount} issue${failedCount === 1 ? '' : 's'}`);

      toast({
        title: `Imported ${importedCount} track${importedCount === 1 ? '' : 's'}`,
        description: parts.length > 0 ? parts.join(' • ') : 'Analyzing BPM in the background.',
      });
    },

    deleteTrackById: async (id: string) => {
      // Back-compat: treat as "remove from library" with full cleanup.
      await get().removeFromLibrary(id, {reason: 'user'});
    },

    removeFromLibrary: async (trackId: string) => {
      const stateBefore = get();

      // 1) Remove from library storage.
      await deleteTrack(trackId);
      set(state => ({ tracks: state.tracks.filter(t => t.id !== trackId) }));

      // 2) Remove from every playlist that contains it.
      const playlistsToUpdate = stateBefore.playlists.filter(p => p.trackIds.includes(trackId));
      if (playlistsToUpdate.length > 0) {
        await Promise.all(
          playlistsToUpdate.map(async (p) => {
            const newTrackIds = p.trackIds.filter(id => id !== trackId);
            await updatePlaylist(p.id, { trackIds: newTrackIds });
          }),
        );

        set(state => ({
          playlists: state.playlists.map(p =>
            p.trackIds.includes(trackId) ? { ...p, trackIds: p.trackIds.filter(id => id !== trackId) } : p,
          ),
        }));
      }

      // 3) Remove from active queue if present + skip/stop if currently playing.
      const stateMid = get();
      const q = computeQueueAfterRemoval(stateMid, trackId);
      if (q) {
        set({ partyTrackIds: q.nextIds, nowPlayingIndex: q.nextNow });
        if (q.nextIds.length === 0) {
          get().stopPartyMode();
        } else if (q.shouldAdvance) {
          await jumpToQueueIndex(q.nextNow);
        }
      }

      // 4) If loaded on a deck outside Party Mode, stop it.
      stopDeckIfTrackMatches(trackId);

      toast({
        title: 'Removed from Library',
        description: 'Track removed from Library, playlists, and queue.',
      });
    },

    removeFromPlaylist: async (playlistId: string, trackId: string) => {
      const stateBefore = get();
      const playlist = stateBefore.playlists.find(p => p.id === playlistId);
      if (!playlist) return;

      const newTrackIds = playlist.trackIds.filter(id => id !== trackId);
      await updatePlaylist(playlistId, { trackIds: newTrackIds });

      set(state => ({
        playlists: state.playlists.map(p =>
          p.id === playlistId ? { ...p, trackIds: newTrackIds } : p,
        ),
      }));

      // If playing from this playlist, remove from queue too.
      const stateMid = get();
      if (stateMid.isPartyMode && stateMid.partySource?.type === 'playlist' && stateMid.partySource.playlistId === playlistId) {
        const q = computeQueueAfterRemoval(stateMid, trackId);
        if (q) {
          set({ partyTrackIds: q.nextIds, nowPlayingIndex: q.nextNow });
          if (q.nextIds.length === 0) {
            get().stopPartyMode();
          } else if (q.shouldAdvance) {
            await jumpToQueueIndex(q.nextNow);
          }
        }
      }

      toast({
        title: 'Removed from Playlist',
        description: `Track removed from "${playlist.name}".`,
      });
    },

    removeFromCurrentSource: async (trackId: string) => {
      const state = get();
      const source = state.partySource;

      if (source?.type === 'playlist' && source.playlistId) {
        await get().removeFromPlaylist(source.playlistId, trackId);
        return;
      }

      // Default: Import List (library)
      await get().removeFromLibrary(trackId, {reason: 'user'});
    },

    loadTrackToDeck: async (trackId: string, deck: DeckId, offsetSeconds?: number) => {
      const state = get();
      const track = state.tracks.find(t => t.id === trackId);
      if (!track?.fileBlob) return;

      // Apply track gain if auto volume match is enabled (compute on-demand if missing)
      const gainDb = await ensureGainDbForTrack(track, state.settings);

      const duration = offsetSeconds !== undefined
        ? await audioEngine.loadTrackWithOffset(deck, track.fileBlob, offsetSeconds, track.bpm, gainDb)
        : await audioEngine.loadTrack(deck, track.fileBlob, track.bpm, gainDb);

      // Set base BPM for tempo matching
      if (track.bpm) {
        audioEngine.setBaseBpm(deck, track.bpm);
      }

      // Provide the analyzed "musical end" (if available) so automix avoids trailing silence.
      try {
        if (import.meta.env.DEV) {
          console.log(`[loadTrackToDeck] Setting trueEndTime for deck ${deck}:`, {
            trackId,
            duration,
            trueEndTime: track.trueEndTime,
            hasTrueEndTime: track.trueEndTime !== undefined && track.trueEndTime !== null,
          });
        }
        audioEngine.setTrueEndTime(deck, track.trueEndTime);
      } catch (error) {
        console.error(`[loadTrackToDeck] Failed to set trueEndTime on deck ${deck}:`, error);
      }

      if (deck === 'A') {
        set({ deckA: { ...initialDeckState, trackId, duration, currentTime: offsetSeconds ?? 0 } });
      } else {
        set({ deckB: { ...initialDeckState, trackId, duration, currentTime: offsetSeconds ?? 0 } });
      }

      // Ensure the newly-loaded deck reflects the user's current tempo settings.
      // (AudioEngine resets playbackRate to 1 on each load.)
      try {
        applyImmediateTempoToDeck(get(), deck);
      } catch {
        // ignore
      }
    },

    play: (deck?: DeckId) => {
      const targetDeck = deck || get().activeDeck;

      // Defensive: resync tempo to settings before starting playback.
      // This helps after navigation/reloads where the engine may have reset to 1.0.
      try {
        applyImmediateTempoToDeck(get(), targetDeck);
      } catch {
        // ignore
      }

      audioEngine.play(targetDeck);

      if (targetDeck === 'A') {
        set(state => ({ deckA: { ...state.deckA, isPlaying: true }, activeDeck: 'A' }));
      } else {
        set(state => ({ deckB: { ...state.deckB, isPlaying: true }, activeDeck: 'B' }));
      }
    },

    pause: (deck?: DeckId) => {
      const targetDeck = deck || get().activeDeck;
      audioEngine.pause(targetDeck);

      if (targetDeck === 'A') {
        set(state => ({ deckA: { ...state.deckA, isPlaying: false } }));
      } else {
        set(state => ({ deckB: { ...state.deckB, isPlaying: false } }));
      }
    },

    togglePlayPause: (deck?: DeckId) => {
      const targetDeck = deck || get().activeDeck;
      const deckState = targetDeck === 'A' ? get().deckA : get().deckB;

      if (deckState.isPlaying) {
        get().pause(targetDeck);
      } else {
        get().play(targetDeck);
      }
    },

    seek: (deck: DeckId, time: number) => {
      audioEngine.seek(deck, time);
      if (deck === 'A') {
        set(state => ({ deckA: { ...state.deckA, currentTime: time } }));
      } else {
        set(state => ({ deckB: { ...state.deckB, currentTime: time } }));
      }
    },

    restartCurrentTrack: (arg?: DeckId | { deck?: DeckId; reason?: string; silent?: boolean }) => {
      // 1. CANCEL any pending auto-mix so restart doesn't fade into next track
      clearScheduledTimeouts();
      try {
        audioEngine.enableMixCheck(false);
        audioEngine.resetMixTrigger();
      } catch {
        // ignore
      }

      // Clear mix in progress flag
      set({ mixInProgress: false });

      // SET GRACE PERIOD - 5 seconds, no auto-mix allowed
      restartGraceUntilMs = Date.now() + 5000;

      const state0 = get();
      const deck = typeof arg === 'string' ? arg : arg?.deck;
      const reason = typeof arg === 'string' ? undefined : arg?.reason;
      const silent = typeof arg === 'string' ? false : Boolean(arg?.silent);

      const isRepeatRestart = reason === 'repeat_end' || state0.settings.repeatMode === 'track';

      const state = get();
      const targetDeck = deck || state.activeDeck;
      const track = getDeckTrack(state, targetDeck);
      if (!track) return;

      // 2. Do the restart/seek - go back to normal start position
      // Ignore onended event from the stop() that seek() triggers (800ms is plenty for stop->seek->play)
      audioEngine.ignoreEndedFor(targetDeck, 800);
      const startAt = isRepeatRestart ? 0 : getEffectiveStartTimeSec(track, state.settings);
      audioEngine.seek(targetDeck, startAt);

      if (targetDeck === 'A') {
        set(s => ({ deckA: { ...s.deckA, currentTime: startAt } }));
      } else {
        set(s => ({ deckB: { ...s.deckB, currentTime: startAt } }));
      }

      // 3. AFTER seek completes, recompute trigger threshold from NEW position
      // Delay to let seek settle and position update
      setTimeout(() => {
        const currentState = get();
        if (currentState.isPartyMode && currentState.settings.repeatMode !== 'track') {
          // Recompute trigger based on current track state AFTER seek
          const triggerSecondsTrack = computeAutoMixTriggerSecondsTrack(currentState);
          audioEngine.setMixTriggerConfig('remaining', triggerSecondsTrack);
          audioEngine.resetMixTrigger();  // Reset the "already fired" flag
          audioEngine.enableMixCheck(true);
        }
      }, 100);

      if (!silent) {
        toast({
          title: 'Restarted',
          description: isRepeatRestart
            ? 'Track restarting from beginning'
            : `Start: ${Math.floor(startAt / 60)}:${Math.floor(startAt % 60).toString().padStart(2, '0')}`,
        });
      }
    },

    playPreviousTrack: async (deck?: DeckId) => {
      const state = get();
      const targetDeck = deck || state.activeDeck;
      const prevDeck: DeckId = targetDeck === 'A' ? 'B' : 'A';
      const wasMixing = state.mixInProgress;

      if (!state.isPartyMode || state.partyTrackIds.length === 0) {
        // Non-party mode: no queue context, so just restart.
        get().restartCurrentTrack(targetDeck);
        return;
      }

      if (state.nowPlayingIndex === 0 && state.settings.repeatMode !== 'playlist') {
        get().restartCurrentTrack(targetDeck);
        return;
      }

      const currentTrackId = state.partyTrackIds[state.nowPlayingIndex] ?? null;
      const history = state.playHistoryTrackIds;
      const historyCandidate = history.length > 0 ? history[history.length - 1] : null;
      const historyIndex = historyCandidate ? state.partyTrackIds.indexOf(historyCandidate) : -1;

      const computedFallbackIndex = state.nowPlayingIndex > 0
        ? state.nowPlayingIndex - 1
        : (state.settings.repeatMode === 'playlist' ? state.partyTrackIds.length - 1 : 0);

      const fallbackTrackId = state.partyTrackIds[computedFallbackIndex] ?? null;
      const useHistory = historyCandidate && historyCandidate !== currentTrackId && historyIndex >= 0;
      const targetTrackId = useHistory ? historyCandidate : fallbackTrackId;

      const previousIndex = targetTrackId ? Math.max(0, state.partyTrackIds.indexOf(targetTrackId)) : computedFallbackIndex;
      const previousTrackId = state.partyTrackIds[previousIndex];
      const previousTrack = state.tracks.find(t => t.id === previousTrackId);
      if (!previousTrack?.fileBlob) return;

      const nextHistory = useHistory ? history.slice(0, -1) : history;

      // Cancel any scheduled next/auto transition, source switches, and any scheduled WebAudio stops.
      // Keep `mixInProgress` true while we prepare the new transition so auto-next/end events cannot
      // schedule a new skip in the tiny window between cancel + starting the prev mix.
      cancelPendingTransition({ mixInProgress: true, reason: 'previous_track' });

      // If an actual mix is in-flight, bail out to a predictable "hard" previous.
      // (Crossfading while another crossfade + stop scheduling is in progress is hard to make bulletproof.)
      if (wasMixing) {
        const currentDeckState = getDeckState(state, targetDeck);
        const wasPlaying = audioEngine.isPlaying(targetDeck) || currentDeckState.isPlaying;
        const tempoControlEnabled = usePlanStore.getState().hasFeature('tempoControl');
        const preservedTempo = tempoControlEnabled
          ? Math.max(0.25, audioEngine.getTempo(targetDeck) || currentDeckState.playbackRate || 1)
          : 1;

        const gainDb = await ensureGainDbForTrack(previousTrack, state.settings);
        const startAt = getEffectiveStartTimeSec(previousTrack, state.settings);
        const duration = await audioEngine.loadTrackWithOffset(targetDeck, previousTrack.fileBlob, startAt, previousTrack.bpm, gainDb);
        if (previousTrack.bpm) audioEngine.setBaseBpm(targetDeck, previousTrack.bpm);
        get().setTempo(targetDeck, preservedTempo);

        if (targetDeck === 'A') {
          set({ deckA: { ...initialDeckState, trackId: previousTrackId, duration, currentTime: startAt, playbackRate: preservedTempo } });
        } else {
          set({ deckB: { ...initialDeckState, trackId: previousTrackId, duration, currentTime: startAt, playbackRate: preservedTempo } });
        }

        set({
          activeDeck: targetDeck,
          nowPlayingIndex: previousIndex,
          pendingNextIndex: null,
          pendingSourceSwitch: null,
          queuedSourceSwitch: null,
          playHistoryTrackIds: nextHistory,
          crossfadeValue: targetDeck === 'A' ? 0 : 1,
        });
        audioEngine.setCrossfade(targetDeck === 'A' ? 0 : 1);

        if (wasPlaying) {
          audioEngine.play(targetDeck);
          if (targetDeck === 'A') set(s => ({ deckA: { ...s.deckA, isPlaying: true } }));
          else set(s => ({ deckB: { ...s.deckB, isPlaying: true } }));
        }

        const after = get();
        const triggerSecondsTrack = computeAutoMixTriggerSecondsTrack(after);
        audioEngine.setMixTriggerConfig('remaining', triggerSecondsTrack);
        const enableMixCheck = after.settings.repeatMode !== 'track';
        audioEngine.enableMixCheck(enableMixCheck);
        audioEngine.resetMixTrigger();

        return;
      }

      const currentDeckState = getDeckState(state, targetDeck);
      const outgoingTrackId = currentDeckState.trackId;
      const wasPlaying = audioEngine.isPlaying(targetDeck) || currentDeckState.isPlaying;

      const tempoControlEnabled = usePlanStore.getState().hasFeature('tempoControl');
      const preservedTempo = tempoControlEnabled
        ? Math.max(0.25, audioEngine.getTempo(targetDeck) || currentDeckState.playbackRate || 1)
        : 1;

      const startOffsetSeconds = getEffectiveStartTimeSec(previousTrack, state.settings);
      const effectiveCrossfadeSeconds = clamp(state.settings.crossfadeSeconds ?? 8, 1, 20);
      const gainDbPromise = ensureGainDbForTrack(previousTrack, state.settings);

      set({ mixInProgress: true });

      audioEngine.loadTrackWithOffset(
        prevDeck,
        previousTrack.fileBlob,
        startOffsetSeconds,
        previousTrack.bpm,
        undefined
      ).then((duration) => {
        void gainDbPromise.then((gainDb) => {
          if (gainDb !== undefined) audioEngine.setTrackGain(prevDeck, gainDb);
          else audioEngine.setTrackGain(prevDeck, 0);
        });

        if (previousTrack.bpm) audioEngine.setBaseBpm(prevDeck, previousTrack.bpm);
        get().setTempo(prevDeck, preservedTempo);

        // Ensure we crossfade from the currently audible deck.
        audioEngine.setCrossfade(targetDeck === 'A' ? 0 : 1);
        set({ crossfadeValue: targetDeck === 'A' ? 0 : 1 });

        const ctxNow = audioEngine.getAudioContextTime();
        const startAt = ctxNow !== null ? (ctxNow + 0.05) : null;
        const fadeAt = startAt;

        if (startAt !== null && fadeAt !== null) {
          audioEngine.playAt(prevDeck, startAt);
          audioEngine.scheduleCrossfade(effectiveCrossfadeSeconds, fadeAt);

          const stopAt = fadeAt + effectiveCrossfadeSeconds;
          audioEngine.scheduleStop(targetDeck, stopAt + 0.02);

          const now = audioEngine.getAudioContextTime() ?? ctxNow;
          const startDelayMs = Math.max(0, (startAt - now) * 1000);
          const stopDelayMs = Math.max(0, (stopAt - now) * 1000);

          scheduledTimeouts.push(setTimeout(() => {
            if (prevDeck === 'A') {
              set(s => ({ deckA: { ...s.deckA, isPlaying: true } }));
            } else {
              set(s => ({ deckB: { ...s.deckB, isPlaying: true } }));
            }
          }, startDelayMs));

          scheduledTimeouts.push(setTimeout(() => {
            get().pause(targetDeck);
            audioEngine.resetMixTrigger();
            set((s) => ({
              activeDeck: prevDeck,
              nowPlayingIndex: previousIndex,
              pendingNextIndex: null,
              pendingSourceSwitch: null,
              queuedSourceSwitch: null,
              mixInProgress: false,
              crossfadeValue: prevDeck === 'A' ? 0 : 1,
              playHistoryTrackIds: nextHistory,
            }));

            // Recompute automix trigger for the new outgoing deck.
            const newState = get();
            const triggerSecondsTrack = computeAutoMixTriggerSecondsTrack(newState);
            audioEngine.setMixTriggerConfig('remaining', triggerSecondsTrack);
            audioEngine.enableMixCheck(newState.settings.repeatMode !== 'track');
          }, stopDelayMs));
        } else {
          // Fallback: start immediately and do an immediate crossfade schedule.
          audioEngine.play(prevDeck);
          void audioEngine.crossfade(effectiveCrossfadeSeconds);
          scheduledTimeouts.push(setTimeout(() => {
            get().pause(targetDeck);
            set((s) => ({
              activeDeck: prevDeck,
              nowPlayingIndex: previousIndex,
              pendingNextIndex: null,
              pendingSourceSwitch: null,
              queuedSourceSwitch: null,
              mixInProgress: false,
              crossfadeValue: prevDeck === 'A' ? 0 : 1,
              playHistoryTrackIds: nextHistory,
            }));
          }, Math.round(effectiveCrossfadeSeconds * 1000)));
        }

        if (prevDeck === 'A') {
          set({ deckA: { ...initialDeckState, trackId: previousTrackId, duration, currentTime: startOffsetSeconds, playbackRate: preservedTempo } });
        } else {
          set({ deckB: { ...initialDeckState, trackId: previousTrackId, duration, currentTime: startOffsetSeconds, playbackRate: preservedTempo } });
        }

        toast({ title: 'Previous Track' });
      }).catch((error) => {
        console.error('[DJ Store] playPreviousTrack() failed to load previous track:', error);
        set({ mixInProgress: false });
      });
    },

    smartBack: (deck?: DeckId) => {
      const state = get();
      const targetDeck = deck || state.activeDeck;
      // Back always means "previous track" (crossfade mix) in Party Mode.
      // Replay/Restart is a separate control (hard seek), so Back should not restart.
      cancelPendingTransition();
      void get().playPreviousTrack(targetDeck);
    },

    skip: (reason: 'user' | 'auto' | 'end' | 'switch' = 'user') => {
      const state = get();
      const { partyTrackIds, nowPlayingIndex, pendingNextIndex, settings, activeDeck, tracks } = state;

      if (!state.isPartyMode || partyTrackIds.length === 0) return;
      if (state.mixInProgress) return;

      // Hard guard: Repeat Track mode should never auto-mix or auto-advance.
      if (settings.repeatMode === 'track' && (reason === 'auto' || reason === 'end')) {
        if (reason === 'end') {
          get().restartCurrentTrack({ deck: activeDeck, reason: 'repeat_end', silent: true });
        }
        return;
      }

      clearScheduledTimeouts();

      // Determine next index
      let nextIndex: number;

      if (pendingNextIndex !== null) {
        nextIndex = pendingNextIndex;
        set({ pendingNextIndex: null });
      } else {
        nextIndex = nowPlayingIndex + 1;
      }

      // Check bounds
      if (nextIndex >= partyTrackIds.length) {
        if (settings.repeatMode === 'playlist') {
          nextIndex = 0;
        } else {
          get().stopPartyMode();
          return;
        }
      }

      const nextTrackId = partyTrackIds[nextIndex];
      const nextTrack = tracks.find(t => t.id === nextTrackId);
      const nextDeck = activeDeck === 'A' ? 'B' : 'A';
      const currentDeck = activeDeck;
      const currentDeckState = activeDeck === 'A' ? state.deckA : state.deckB;
      const currentTrack = tracks.find(t => t.id === currentDeckState.trackId);
      const outgoingTrackId = currentDeckState.trackId;

      // Repeat-one behavior (playlist wrap on a 1-track queue): if we resolve "next" to the same track,
      // do a self-blend loop.
      const isSelfBlend = Boolean(outgoingTrackId) && nextTrackId === outgoingTrackId;
      const postNowPlayingIndex = isSelfBlend ? nowPlayingIndex : nextIndex;

      if (!nextTrack?.fileBlob) return;

      // Party Mode Tempo Match (crossfade-synced):
      // - Choose a shared target BPM based on the incoming track BPM (plus optional offset)
      // - Ramp the outgoing deck into that BPM leading into the crossfade
      // - Start the incoming deck already set to its matched playbackRate
      // - Keep the new track at that matched tempo after transition (Option A)
      const tempoControlEnabled = usePlanStore.getState().hasFeature('tempoControl');
      const nextBaseBpm = nextTrack?.bpm || 120;
      const outgoingBaseBpm = currentTrack?.bpm || audioEngine.getBaseBpm(currentDeck) || 120;

      const hasIncomingBpm = Number.isFinite(nextTrack?.bpm) && (nextTrack?.bpm as number) > 0;
      const hasOutgoingBpm = Number.isFinite(outgoingBaseBpm) && outgoingBaseBpm > 0;

      const halfDoubleTelemetry = (() => {
        const incoming = Number.isFinite(nextBaseBpm) ? nextBaseBpm : 0;
        const outgoing = Number.isFinite(outgoingBaseBpm) ? outgoingBaseBpm : 0;
        if (!incoming || !outgoing) return { possibleHalfDouble: false, altTargetBpm: null as number | null };

        // Telemetry-only heuristic: BPM analyzers frequently land at 1/2× or 2×.
        // Flag cases where the two tracks are close under a 2× relationship.
        const thresholdBpm = 2;
        if (Math.abs(outgoing - incoming * 2) <= thresholdBpm) {
          return { possibleHalfDouble: true, altTargetBpm: incoming * 2 };
        }
        if (Math.abs(incoming - outgoing * 2) <= thresholdBpm) {
          return { possibleHalfDouble: true, altTargetBpm: outgoing * 2 };
        }
        return { possibleHalfDouble: false, altTargetBpm: null as number | null };
      })();

      const computeTransitionTargetBpm = (): number => {
        if (!tempoControlEnabled) return nextBaseBpm;
        if (settings.tempoMode === 'locked') {
          return Number.isFinite(settings.lockedBpm) && settings.lockedBpm > 0 ? settings.lockedBpm : nextBaseBpm;
        }
        if (settings.tempoMode === 'auto') {
          // Auto Match behavior: use the user's chosen target BPM.
          return getCanonicalTargetBpm(settings) ?? nextBaseBpm;
        }
        if (settings.tempoMode === 'preset') {
          // Preset behavior: compute target based on preset ratio applied to incoming track's BPM
          const preset = settings.tempoPreset ?? 'original';
          const result = computePresetTempo(nextBaseBpm, preset);
          return result.targetBpm;
        }
        return nextBaseBpm;
      };

      const targetBpm = computeTransitionTargetBpm();

      // Get track gain for volume matching
      // Gain can be undefined for older imports; compute lazily if needed.
      const gainDbPromise = nextTrack ? ensureGainDbForTrack(nextTrack, settings) : Promise.resolve(undefined);

      const ctxNow = audioEngine.getAudioContextTime();
      if (ctxNow === null) return;

      // DJ Logic timing
      const startOffsetSeconds = isSelfBlend ? 0 : clamp(settings.nextSongStartOffset ?? 0, 0, 120);
      const endEarlySeconds = clamp(settings.endEarlySeconds ?? 0, 0, 60);
      const effectiveCrossfadeSeconds = clamp(settings.crossfadeSeconds ?? 8, 1, 20);

      // Fixed "normal" profile for quantization/ramp/settle behavior.
      const energy = {
        settleBeats: 2,
        stepLargeDeltas: false,
      };

      // Manual Next should transition immediately (on-beat), not wait until track end.
      const isManualImmediate = reason === 'user' || reason === 'end' || reason === 'switch';

      // Use engine timing for scheduling math to avoid drift between store state and WebAudio.
      const outgoingDurationTrack = audioEngine.getDuration(currentDeck) || currentDeckState.duration || 0;
      const outgoingTimeTrack = audioEngine.getCurrentTime(currentDeck) || currentDeckState.currentTime || 0;
      const outgoingRemainingTrack = Math.max(0, outgoingDurationTrack - outgoingTimeTrack);
      const outgoingRate = Math.max(0.25, audioEngine.getTempo(currentDeck) || currentDeckState.playbackRate || 1);
      const outgoingRemainingReal = outgoingRemainingTrack / outgoingRate;
      const outgoingEndCtx = ctxNow + outgoingRemainingReal;

      // Latest moment we can start crossfade while still respecting End Early (minimum).
      const latestCrossfadeStart = outgoingEndCtx - endEarlySeconds - effectiveCrossfadeSeconds;
      const safeLatestCrossfadeStart = Math.max(ctxNow + 0.05, latestCrossfadeStart);

      const beatSec = 60 / Math.max(1, targetBpm);
      const barSec = beatSec * 4;
      const rampSecWanted = computeTempoRampSecFromCrossfade(effectiveCrossfadeSeconds);
      const settleSec = beatSec * energy.settleBeats;
      const bpmDeltaIncoming = Math.abs(targetBpm - nextBaseBpm);
      const bpmDeltaOutgoing = Math.abs(targetBpm - outgoingBaseBpm);
      const bpmDelta = Math.max(bpmDeltaIncoming, bpmDeltaOutgoing);

      // Pre-roll needed to ramp + settle before crossfade begins.
      const preRollSec = energy.stepLargeDeltas && bpmDelta > 6
        ? (rampSecWanted + barSec + rampSecWanted + settleSec)
        : (rampSecWanted + settleSec);

      let incomingStartAt: number;
      let fadeAt: number;

      // Compute the outgoing deck's matched playbackRate (used for beat quantization + ramp scheduling).
      const tempoMatchSafeModeEnabled = tempoControlEnabled && settings.tempoMode === 'auto';
      // Product: Auto-sync is a safety feature.
      // Soft default is handled via settings defaults (8%). Hard cap is maxTempoPercent (clamped to 12%).
      const safeModeShiftCeilingPct = Math.max(0, resolveMaxTempoPercent(settings?.maxTempoPercent, 8));
      const requiredIncomingShiftPct = computeRequiredTempoShiftPercent(nextBaseBpm, targetBpm);
      const requiredOutgoingShiftPct = computeRequiredTempoShiftPercent(outgoingBaseBpm, targetBpm);
      const requiredShiftPct = Math.max(requiredIncomingShiftPct, requiredOutgoingShiftPct);
      const missingBpmDisables = tempoMatchSafeModeEnabled && (!hasIncomingBpm || !hasOutgoingBpm);
      const overCap = tempoMatchSafeModeEnabled && isOverTempoCap(requiredShiftPct, safeModeShiftCeilingPct);
      // Preset mode always applies its ratio (even "original" at 1.0×), so don't disable it
      const shouldDisableTempoMatchThisTransition = missingBpmDisables || overCap;

      const disabledReason: 'over_cap' | 'missing_bpm' | 'user_disabled' | null = (() => {
        if (!tempoControlEnabled) return 'user_disabled';
        if (missingBpmDisables) return 'missing_bpm';
        if (overCap) return 'over_cap';
        return null;
      })();


      set({
        lastTransitionTempoMatchDisabled: shouldDisableTempoMatchThisTransition,
        lastTransitionTempoMatchRequiredPct: Number.isFinite(requiredShiftPct) ? requiredShiftPct : null,
        lastTransitionTempoMatchCeilingPct: Number.isFinite(safeModeShiftCeilingPct) ? safeModeShiftCeilingPct : null,
        lastTransitionTempoPlan: {
          mode: !tempoControlEnabled
            ? 'original'
            : settings.tempoMode === 'locked'
              ? 'locked'
              : settings.tempoMode === 'auto'
                ? 'party'
                : settings.tempoMode === 'preset'
                  ? 'preset'
                : 'original',
          nextBaseBpmUsed: Number.isFinite(nextBaseBpm) ? nextBaseBpm : null,
          outgoingBaseBpmUsed: Number.isFinite(outgoingBaseBpm) ? outgoingBaseBpm : null,
          targetBpmUsed: Number.isFinite(targetBpm) ? targetBpm : null,
          targetBpm: Number.isFinite(targetBpm) ? targetBpm : null,
          outgoingTargetRatio: 1,
          incomingTargetRatio: 1,
          requiredIncomingPercent: Number.isFinite(requiredIncomingShiftPct) ? requiredIncomingShiftPct : null,
          requiredOutgoingPercent: Number.isFinite(requiredOutgoingShiftPct) ? requiredOutgoingShiftPct : null,
          requiredPercent: Number.isFinite(requiredShiftPct) ? requiredShiftPct : null,
          capPctUsed: Number.isFinite(safeModeShiftCeilingPct) ? safeModeShiftCeilingPct : null,
          overCap: tempoMatchSafeModeEnabled ? overCap : null,
          tempoMatchDisabled: shouldDisableTempoMatchThisTransition || !tempoControlEnabled,
          disabledReason,
          possibleHalfDouble: halfDoubleTelemetry.possibleHalfDouble,
          altTargetBpm: halfDoubleTelemetry.altTargetBpm,
          postTransitionPolicy: (!tempoControlEnabled || shouldDisableTempoMatchThisTransition)
            ? 'neutralTo1.0'
            : ((settings.partyTempoAfterTransition ?? 'hold') === 'revert' ? 'revert' : 'hold'),
          rampStartAt: null,
          rampEndAt: null,
          rampSecWanted: rampSecWanted,
          rampSecActual: null,
          quantizedTo: null,
        },
      });

      const computedOutgoing = (tempoControlEnabled && !shouldDisableTempoMatchThisTransition)
        ? computeTempoForDeck(currentDeck, targetBpm, getEffectiveMaxTempoPercent(settings))
        : null;

      const outgoingTargetRatio = computedOutgoing ? computedOutgoing.ratio : 1;

      if (isManualImmediate) {
        const startCandidate = ctxNow + 0.05;
        // Manual: keep it snappy, but still bar-aligned.
        incomingStartAt = audioEngine.getNextBeatTimeFrom(currentDeck, startCandidate, barsToBeats(1), outgoingTargetRatio) ?? startCandidate;
        fadeAt = audioEngine.getNextBeatTimeFrom(currentDeck, incomingStartAt, barsToBeats(1), outgoingTargetRatio) ?? incomingStartAt;

        set((s) => ({
          lastTransitionTempoPlan: s.lastTransitionTempoPlan
            ? { ...s.lastTransitionTempoPlan, outgoingTargetRatio, quantizedTo: '1bar' }
            : s.lastTransitionTempoPlan,
        }));
      } else {
        // Auto: prefer phrase boundaries when there's time.
        const phraseBarsPreferred = [16, 8, 4, 1];
        const phraseBeatMultiples = phraseBarsPreferred.map(barsToBeats);

        // Incoming can start earlier (muted by crossfade position) to allow ramp+settle.
        const earliestIncomingStart = Math.max(ctxNow + 0.05, safeLatestCrossfadeStart - preRollSec);
        const quantIncomingStart = quantizeNextUpToWithInfo(
          currentDeck,
          earliestIncomingStart,
          phraseBeatMultiples,
          outgoingTargetRatio,
          safeLatestCrossfadeStart
        );
        incomingStartAt = quantIncomingStart.time > safeLatestCrossfadeStart ? safeLatestCrossfadeStart : quantIncomingStart.time;

        // Compute crossfade start as soon as we're "ready" (after pre-roll), but never after latestCrossfadeStart.
        const fadeCandidate = incomingStartAt + preRollSec;
        const fadeQuant = quantizeNextUpToWithInfo(
          currentDeck,
          fadeCandidate,
          phraseBeatMultiples,
          outgoingTargetRatio,
          safeLatestCrossfadeStart
        );

        fadeAt = fadeQuant.time;
        set((s) => ({
          lastTransitionTempoPlan: s.lastTransitionTempoPlan
            ? {
                ...s.lastTransitionTempoPlan,
                outgoingTargetRatio,
                quantizedTo: beatMultipleToQuantizedLabel(fadeQuant.beatMultipleUsed),
              }
            : s.lastTransitionTempoPlan,
        }));
      }

      set({ mixInProgress: true });

      // Load next track with offset
      audioEngine.loadTrackWithOffset(
        nextDeck,
        nextTrack.fileBlob,
        startOffsetSeconds,
        nextTrack.bpm,
        undefined
      ).then((duration) => {
        void gainDbPromise.then((gainDb) => {
          if (gainDb !== undefined) audioEngine.setTrackGain(nextDeck, gainDb);
          else audioEngine.setTrackGain(nextDeck, 0);
        });
        const tempoControlEnabled = usePlanStore.getState().hasFeature('tempoControl');

        // Start incoming early (inaudible until crossfade begins).
        if (!tempoControlEnabled || shouldDisableTempoMatchThisTransition) {
          // Free mode: keep pitch/BPM normal.
          get().setTempo(nextDeck, 1);
        } else {
          // Incoming deck starts already matched to the shared target BPM.
          const computedIncoming = computeTempoForDeck(nextDeck, targetBpm, getEffectiveMaxTempoPercent(settings));
          const incomingTargetRatio = computedIncoming.ratio;
          set({ lastTempoDebug: computedIncoming.debug });
          get().setTempo(nextDeck, incomingTargetRatio);

          // Ramp outgoing deck toward the target leading into the crossfade.
          // Start early so the ramp finishes at the end of the crossfade.
          // Rule: rampSecWanted = clamp(crossfadeSec*2, 4, 20), but snap to bars.
          // Keep the start in a safe window so quantization doesn't make ramps feel random.
          const rampEndAt = fadeAt + effectiveCrossfadeSeconds;
          const minRampSec = 4;
          const maxRampSec = 20;
          const earliestStart = rampEndAt - maxRampSec;
          const latestStart = rampEndAt - minRampSec;
          const minStart = Math.max(ctxNow + 0.05, earliestStart);
          const maxStart = Math.max(minStart, latestStart);
          const idealStart = clamp(rampEndAt - rampSecWanted, minStart, maxStart);
          const rampStartAt = chooseBeatAlignedTimeInRange(
            currentDeck,
            idealStart,
            barsToBeats(1),
            minStart,
            maxStart,
            outgoingTargetRatio
          );
          try {
            audioEngine.rampTempo(currentDeck, outgoingTargetRatio, rampStartAt, Math.round((rampEndAt - rampStartAt) * 1000));
          } catch {
            // ignore
          }

          if (computedOutgoing) set({ lastTempoDebug: computedOutgoing.debug });

          set((s) => ({
            lastTransitionTempoPlan: s.lastTransitionTempoPlan
              ? {
                  ...s.lastTransitionTempoPlan,
                  incomingTargetRatio,
                  rampStartAt,
                  rampEndAt,
                  rampSecWanted,
                  rampSecActual: Math.max(0, rampEndAt - rampStartAt),
                }
              : s.lastTransitionTempoPlan,
          }));
        }

        // Start incoming early (inaudible until crossfade begins).
        audioEngine.playAt(nextDeck, incomingStartAt);

        // Option B: return the *new* track to original tempo by the end of the crossfade.
        // (Only applies to Party Mode + Auto Match; Locked BPM remains authoritative.)
        try {
          const currentState = get();
          const wantsRevert = (currentState.settings.partyTempoAfterTransition ?? 'hold') === 'revert';
          const shouldRevert = wantsRevert && currentState.isPartyMode && currentState.settings.tempoMode === 'auto';
          if (shouldRevert && usePlanStore.getState().hasFeature('tempoControl') && !shouldDisableTempoMatchThisTransition) {
            const rampEndAt = fadeAt + effectiveCrossfadeSeconds;
            const minRampSec = 4;
            const maxRampSec = 20;
            const earliestStart = rampEndAt - maxRampSec;
            const latestStart = rampEndAt - minRampSec;
            const minStart = Math.max(ctxNow + 0.05, earliestStart);
            const maxStart = Math.max(minStart, latestStart);
            const idealStart = clamp(rampEndAt - rampSecWanted, minStart, maxStart);
            // Get tempo outside of state to avoid blocking
            const nextDeckTempo = audioEngine.getTempo(nextDeck) || 1;
            const rampStartAt = chooseBeatAlignedTimeInRange(
              nextDeck,
              idealStart,
              barsToBeats(1),
              minStart,
              maxStart,
              nextDeckTempo
            );
            audioEngine.rampTempo(nextDeck, 1, rampStartAt, Math.round((rampEndAt - rampStartAt) * 1000));
          }
        } catch {
          // ignore
        }

        // Equal-power crossfade.
        audioEngine.scheduleCrossfade(effectiveCrossfadeSeconds, fadeAt);

        const stopAt = fadeAt + effectiveCrossfadeSeconds;
        audioEngine.scheduleStop(currentDeck, stopAt + 0.02);

        const now = audioEngine.getAudioContextTime() ?? ctxNow;
        const startDelayMs = Math.max(0, (incomingStartAt - now) * 1000);
        const stopDelayMs = Math.max(0, (stopAt - now) * 1000);

        scheduledTimeouts.push(setTimeout(() => {
          if (nextDeck === 'A') {
            set(s => ({ deckA: { ...s.deckA, isPlaying: true } }));
          } else {
            set(s => ({ deckB: { ...s.deckB, isPlaying: true } }));
          }
        }, startDelayMs));

        scheduledTimeouts.push(setTimeout(() => {
          get().pause(currentDeck);
          audioEngine.resetMixTrigger();
          set((s) => ({
            activeDeck: nextDeck,
            nowPlayingIndex: postNowPlayingIndex,
            mixInProgress: false,
            playHistoryTrackIds: isSelfBlend ? s.playHistoryTrackIds : pushHistory(s.playHistoryTrackIds, outgoingTrackId),
          }));

          // Post-transition safety: force the new active deck tempo to the intended final value.
          try {
            const tempoControlEnabled = usePlanStore.getState().hasFeature('tempoControl');
            const postState = get();
            const wantsRevert = (postState.settings.partyTempoAfterTransition ?? 'hold') === 'revert';
            const shouldRevert = wantsRevert && postState.isPartyMode && postState.settings.tempoMode === 'auto';

            const finalRatio = (!tempoControlEnabled || shouldDisableTempoMatchThisTransition)
              ? 1
              : (shouldRevert ? 1 : (audioEngine.getTempo(nextDeck) || 1));

            postState.setTempo(nextDeck, finalRatio);
          } catch {
            // ignore
          }

          // Apply any pending source switch by rewriting the queue to the new source.
          const afterMix = get();
          if (afterMix.pendingSourceSwitch) {
            set({
              partySource: afterMix.pendingSourceSwitch.source,
              partyTrackIds: afterMix.pendingSourceSwitch.trackIds,
              nowPlayingIndex: 0,
              pendingNextIndex: null,
              pendingSourceSwitch: null,
              playHistoryTrackIds: [],
            });
          }

          // Recompute automix trigger for the new outgoing deck.
          const newState = get();
          const triggerSecondsTrack = computeAutoMixTriggerSecondsTrack(newState);
          audioEngine.setMixTriggerConfig('remaining', triggerSecondsTrack);
          audioEngine.enableMixCheck(newState.settings.repeatMode !== 'track');

          // If the user picked a different source during the mix, switch now.
          const afterQueued = get();
          if (afterQueued.queuedSourceSwitch) {
            const queued = afterQueued.queuedSourceSwitch;
            set({ queuedSourceSwitch: null });
            void get().switchPartySourceSmooth(queued);
          }
        }, stopDelayMs));

        if (nextDeck === 'A') {
          set({ deckA: { ...initialDeckState, trackId: nextTrackId, duration } });
        } else {
          set({ deckB: { ...initialDeckState, trackId: nextTrackId, duration } });
        }
      }).catch((error) => {
        console.error('[DJ Store] skip() failed to load next track:', error);
        set({ mixInProgress: false });
      });
    },

    startPartyMode: async (source: PartySource) => {
      const state = get();

      // Safety default: whenever the user chooses a source to start Party Mode,
      // ensure we start quiet (max 10%) to avoid unexpected loud playback.
      // Do not *increase* volume if the user already had it lower.
      if (!state.isPartyMode) {
        const current = state.settings.masterVolume ?? 1;
        const initialPartyVolume = 0.1;
        const next = Math.min(current, initialPartyVolume);
        if (next !== current) {
          get().setMasterVolume(next);
        }
      }

      let trackIds = getTrackIdsForPartySource(state, source);

      if (import.meta.env.DEV) {
        console.debug('[DJ Store] Starting party mode with', trackIds.length, 'playable tracks');
      }

      if (state.settings.shuffleEnabled) {
        trackIds = shuffleArray(trackIds);
      }

      if (trackIds.length === 0) {
        console.error('[DJ Store] No playable tracks - all tracks may be missing file data');
        return;
      }

      const firstTrackId = trackIds[0];
      const firstTrack = state.tracks.find(t => t.id === firstTrackId);

      if (!firstTrack?.fileBlob) {
        console.error('[DJ Store] First track has no fileBlob');
        return;
      }

      // Apply Start Offset to the first track in Party Mode as well.
      const startOffsetSeconds = clamp(get().settings.nextSongStartOffset ?? 0, 0, 120);
      await get().loadTrackToDeck(firstTrackId, 'A', startOffsetSeconds);

      // If Auto Match is enabled but has no baseline yet (fresh installs / old settings),
      // capture it from what's currently playing (relative lock starting at 0).
      if (state.settings.tempoMode === 'auto' && state.settings.autoBaseBpm === null) {
        const baseBpm = firstTrack?.bpm ?? audioEngine.getBaseBpm('A') ?? 120;
        const rate = Math.max(0.25, audioEngine.getTempo('A') || 1);
        const effectiveBpm = baseBpm * rate;
        await updateSettings({ autoBaseBpm: effectiveBpm, autoOffsetBpm: 0 });
        set(s => ({ settings: { ...s.settings, autoBaseBpm: effectiveBpm, autoOffsetBpm: 0 } }));
      }

      // Ensure Party Mode starts with tempo settings applied (auto/locked/preset/original).
      try {
        applyImmediateTempoToDeck(get(), 'A');
      } catch {
        // ignore
      }

      set({
        isPartyMode: true,
        partySource: source,
        partyTrackIds: trackIds,
        nowPlayingIndex: 0,
        pendingNextIndex: null,
        pendingSourceSwitch: null,
        queuedSourceSwitch: null,
        playHistoryTrackIds: [],
        activeDeck: 'A',
        crossfadeValue: 0,
      });

      audioEngine.setCrossfade(0);
      get().play('A');

      // Configure automix trigger AFTER party mode is active to avoid a race where
      // AudioEngine triggers before the store considers itself in Party Mode.
      const after = get();
      const triggerSecondsTrack = computeAutoMixTriggerSecondsTrack(after);
      audioEngine.setMixTriggerConfig('remaining', triggerSecondsTrack);
      audioEngine.enableMixCheck(after.settings.repeatMode !== 'track');
      audioEngine.resetMixTrigger();
    },

    stopPartyMode: () => {
      clearScheduledTimeouts();
      // Use hard stop so we also cancel scheduled starts (e.g. during an in-flight mix).
      try {
        audioEngine.stop('A');
        audioEngine.stop('B');
      } catch {
        // ignore
      }

      try {
        audioEngine.enableMixCheck(false);
        audioEngine.resetMixTrigger();
      } catch {
        // ignore
      }

      try {
        audioEngine.setCrossfade(0);
      } catch {
        // ignore
      }

      set((state) => ({
        isPartyMode: false,
        partySource: null,
        partyTrackIds: [],
        nowPlayingIndex: 0,
        pendingNextIndex: null,
        pendingSourceSwitch: null,
        queuedSourceSwitch: null,
        playHistoryTrackIds: [],
        mixInProgress: false,
        activeDeck: 'A',
        crossfadeValue: 0,
        deckA: { ...initialDeckState, playbackRate: state.deckA.playbackRate },
        deckB: { ...initialDeckState, playbackRate: state.deckB.playbackRate },
      }));
    },

    triggerMixNow: () => {
      const state = get();
      if (state.isPartyMode) {
        const hasMore = state.nowPlayingIndex < state.partyTrackIds.length - 1;
        const canLoop = state.settings.repeatMode === 'playlist';
        if (hasMore || canLoop) {
          get().skip('user');
        }
      }
    },

    setPartySource: (source: PartySource | null) => {
      set({ partySource: source });
    },

    switchPartySourceSmooth: async (source: PartySource) => {
      const state = get();
      if (!state.isPartyMode) {
        await get().startPartyMode(source);
        return;
      }
      if (state.mixInProgress) {
        set({ queuedSourceSwitch: source });
        return;
      }

      // If we aren't currently playing anything, do a clean start onto the new source.
      const currentDeckStatePre = state.activeDeck === 'A' ? state.deckA : state.deckB;
      if (!currentDeckStatePre.isPlaying) {
        await get().startPartyMode(source);
        return;
      }

      let trackIds = getTrackIdsForPartySource(state, source);
      if (state.settings.shuffleEnabled) {
        trackIds = shuffleArray(trackIds);
      }
      if (trackIds.length === 0) return;

      const currentDeckState = state.activeDeck === 'A' ? state.deckA : state.deckB;
      const currentTrackId = currentDeckState.trackId;

      // If we don't have a current track loaded, fall back to a clean start.
      if (!currentTrackId) {
        await get().startPartyMode(source);
        return;
      }

      // Insert current track at index 0 so skip('switch') can mix into the new source's first track.
      set({
        partySource: source,
        partyTrackIds: [currentTrackId, ...trackIds],
        nowPlayingIndex: 0,
        pendingNextIndex: 1,
        pendingSourceSwitch: { source, trackIds },
        playHistoryTrackIds: [],
      });

      get().skip('switch');
    },

    saveCurrentPartyAsPlaylist: async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return null;

      const state = get();
      if (!state.isPartyMode || state.partyTrackIds.length === 0) return null;

      const playlist: Playlist = {
        id: generateId(),
        name: trimmed,
        trackIds: [...state.partyTrackIds],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await addPlaylist(playlist);
      set(s => ({ playlists: [...s.playlists, playlist] }));
      return playlist.id;
    },

    // Queue management (playlist-based)
    moveTrackInParty: (fromIndex: number, toIndex: number) => {
      set(state => {
        const newTrackIds = [...state.partyTrackIds];
        const [removed] = newTrackIds.splice(fromIndex, 1);
        newTrackIds.splice(toIndex, 0, removed);

        // Adjust nowPlayingIndex if needed
        let newNowPlayingIndex = state.nowPlayingIndex;
        if (fromIndex === state.nowPlayingIndex) {
          newNowPlayingIndex = toIndex;
        } else if (fromIndex < state.nowPlayingIndex && toIndex >= state.nowPlayingIndex) {
          newNowPlayingIndex--;
        } else if (fromIndex > state.nowPlayingIndex && toIndex <= state.nowPlayingIndex) {
          newNowPlayingIndex++;
        }

        return {
          partyTrackIds: newTrackIds,
          nowPlayingIndex: newNowPlayingIndex,
        };
      });
    },

    playNow: (index: number) => {
      const state = get();
      if (index < 0 || index >= state.partyTrackIds.length) return;

      // Set pending next and trigger skip immediately
      set({ pendingNextIndex: index });
      get().skip('user');
    },

    playNext: (index: number) => {
      // Set this track to play after current track ends
      set({ pendingNextIndex: index });
    },

    shufflePartyTracks: () => {
      set(state => {
        // Keep current track, shuffle the rest
        const currentTrackId = state.partyTrackIds[state.nowPlayingIndex];
        const beforeCurrent = state.partyTrackIds.slice(0, state.nowPlayingIndex);
        const afterCurrent = state.partyTrackIds.slice(state.nowPlayingIndex + 1);

        const shuffled = shuffleArray(afterCurrent);

        return {
          partyTrackIds: [...beforeCurrent, currentTrackId, ...shuffled],
        };
      });
    },

    restartPlaylist: () => {
      const state = get();
      if (state.partyTrackIds.length === 0) return;

      set({ pendingNextIndex: 0 });
      get().skip('user');
    },

    setCrossfade: (value: number) => {
      audioEngine.setCrossfade(value);
      set({ crossfadeValue: value });
    },

    setTempo: (deck: DeckId, ratio: number) => {
      const allowedRatio = usePlanStore.getState().hasFeature('tempoControl') ? ratio : 1;
      audioEngine.setTempo(deck, allowedRatio);
      if (deck === 'A') {
        set(state => ({ deckA: { ...state.deckA, playbackRate: allowedRatio } }));
      } else {
        set(state => ({ deckB: { ...state.deckB, playbackRate: allowedRatio } }));
      }
    },

    syncTempoNow: (_opts?: { reason?: string }) => {
      // Public hook for UI/router/entitlements events.
      // Keep it safe and idempotent.
      try {
        syncTempoNowImpl(get());
      } catch {
        // ignore
      }
    },

    setMasterVolume: (value: number) => {
      const v = clamp(value, 0, 1);
      audioEngine.setMasterVolume(v);
      set(state => ({ settings: { ...state.settings, masterVolume: v } }));

      if (masterVolumeSaveTimeout !== null) {
        clearTimeout(masterVolumeSaveTimeout);
      }
      masterVolumeSaveTimeout = setTimeout(() => {
        void updateSettings({ masterVolume: v });
      }, 250);
    },

    updateUserSettings: async (updates: Partial<Settings>) => {
      const before = get();

      // Tempo mode normalization.
      if (updates.tempoMode !== undefined) {
        const v = updates.tempoMode;
        updates.tempoMode = v === 'locked' || v === 'preset' ? v : 'auto';
      }

      // Tempo preset normalization.
      if (updates.tempoPreset !== undefined) {
        const v = updates.tempoPreset;
        updates.tempoPreset =
          v === 'original' ||
          v === 'chill' ||
          v === 'upbeat' ||
          v === 'club' ||
          v === 'fast'
            ? v
            : (v === 'normal' ? 'upbeat' : (v === 'slow' ? 'chill' : 'original'));

        // Choosing a preset implies preset mode.
        if (updates.tempoMode === undefined) {
          updates.tempoMode = 'preset';
        }
      }

      if (updates.vibesPreset !== undefined) {
        const v = updates.vibesPreset;
        updates.vibesPreset = v === 'warm' || v === 'bright' || v === 'club' || v === 'vocal' ? v : 'flat';
      }

      const rawRepeatMode = updates.repeatMode;
      if (rawRepeatMode !== undefined) {
        updates.repeatMode = rawRepeatMode === 'track' || rawRepeatMode === 'playlist' ? rawRepeatMode : 'off';
      }

      const enablingRepeatTrack =
        updates.repeatMode === 'track' &&
        before.settings.repeatMode !== 'track';

      if (enablingRepeatTrack) {
        // Prevent any pre-armed end-of-song transitions from firing after Repeat Track is enabled.
        cancelPendingTransition('repeat_enabled');
      }

      // If shuffle is being enabled in Party Mode, shuffle the upcoming play order once.
      const shouldShuffleUpcomingNow =
        updates.shuffleEnabled === true &&
        before.settings.shuffleEnabled !== true &&
        before.isPartyMode &&
        before.partyTrackIds.length > 1;

      // Snap Lock Tolerance to bigger 5% increments for stronger impact.
      if (updates.lockTolerancePct !== undefined) {
        const raw = Number(updates.lockTolerancePct);
        const clampedPct = clamp(Number.isFinite(raw) ? raw : 10, 0, 100);
        updates.lockTolerancePct = clamp(Math.round(clampedPct / 5) * 5, 0, 100);
      }

      // Auto Match offset is a simple BPM nudge, clamped to ±50 BPM.
      if (updates.autoOffsetBpm !== undefined) {
        const raw = Number(updates.autoOffsetBpm);
        const clampedOffset = clamp(Number.isFinite(raw) ? raw : 0, -150, 150);
        updates.autoOffsetBpm = clamp(Math.round(clampedOffset / 5) * 5, -150, 150);
      }

      // Auto Match target BPM should be bounded and reasonably quantized.
      if (updates.autoBaseBpm !== undefined) {
        const raw = Number(updates.autoBaseBpm);
        const clampedBpm = clamp(Number.isFinite(raw) ? raw : (before.settings.autoBaseBpm ?? 128), 60, 300);
        updates.autoBaseBpm = Math.round(clampedBpm * 10) / 10;

        // Ensure legacy offset doesn't silently skew the new target.
        updates.autoOffsetBpm = 0;
      }

      // Locked BPM should move in bigger 5 BPM steps.
      if (updates.lockedBpm !== undefined) {
        const raw = Number(updates.lockedBpm);
        const clampedBpm = clamp(Number.isFinite(raw) ? raw : before.settings.lockedBpm, 60, 300);
        updates.lockedBpm = clamp(Math.round(clampedBpm / 5) * 5, 60, 300);
      }

      // Safety clamp: tempo stretch percentage.
      // Allow large changes so big BPM ranges are audible, but keep it bounded.
      if (updates.maxTempoPercent !== undefined) {
        const raw = Number(updates.maxTempoPercent);
        // Product: default 8%, absolute cap 12%.
        const clampedPct = clamp(Number.isFinite(raw) ? raw : before.settings.maxTempoPercent, 0, 12);
        updates.maxTempoPercent = Math.round(clampedPct);
      }

      if (updates.partyTempoAfterTransition !== undefined) {
        const v = updates.partyTempoAfterTransition;
        updates.partyTempoAfterTransition = v === 'revert' ? 'revert' : 'hold';
      }

      // When enabling Auto Match, capture a baseline from the currently playing deck
      // including any tempo stretch already applied, then set slider offset to 0.
      if (updates.tempoMode === 'auto' && before.settings.tempoMode !== 'auto') {
        let deck: DeckId = before.activeDeck;
        try {
          const aPlaying = audioEngine.isPlaying('A');
          const bPlaying = audioEngine.isPlaying('B');
          if (aPlaying && !bPlaying) deck = 'A';
          if (bPlaying && !aPlaying) deck = 'B';
        } catch {
          // ignore
        }

        const deckState = deck === 'A' ? before.deckA : before.deckB;
        const track = deckState.trackId ? before.tracks.find(t => t.id === deckState.trackId) : undefined;

        const baseBpm = track?.bpm ?? audioEngine.getBaseBpm(deck) ?? 120;
        const rate = Math.max(0.25, audioEngine.getEffectiveTempo(deck) || audioEngine.getTempo(deck) || deckState.playbackRate || 1);
        const effectiveBpm = baseBpm * rate;

        updates.autoBaseBpm = Math.round(effectiveBpm * 10) / 10;
        updates.autoOffsetBpm = 0;
      }

      // When enabling Preset mode, default to an existing preset if not set.
      if (updates.tempoMode === 'preset' && before.settings.tempoMode !== 'preset') {
        if (updates.tempoPreset === undefined) {
          updates.tempoPreset = before.settings.tempoPreset ?? 'original';
        }
      }

      // When enabling Tempo Lock, default the master BPM to the current playback BPM.
      if (updates.tempoMode === 'locked' && before.settings.tempoMode !== 'locked') {
        const deck = before.activeDeck;
        const deckState = deck === 'A' ? before.deckA : before.deckB;
        const track = deckState.trackId ? before.tracks.find(t => t.id === deckState.trackId) : undefined;

        const baseBpm = track?.bpm ?? audioEngine.getBaseBpm(deck) ?? 120;
        const rate = Math.max(0.25, audioEngine.getEffectiveTempo(deck) || deckState.playbackRate || 1);
        const effectiveBpm = baseBpm * rate;
        // Default to nearest 5 BPM so the slider + behavior feel consistent.
        updates.lockedBpm = clamp(Math.round(effectiveBpm / 5) * 5, 60, 300);
      }

      // Apply settings immediately for responsive controls (sliders/toggles).
      set(state => ({ settings: { ...state.settings, ...updates } }));

      const state = get();

      // Make Master BPM / tempo mode changes apply instantly to the currently playing deck(s).
      if (
        updates.tempoMode !== undefined ||
        updates.tempoPreset !== undefined ||
        updates.lockedBpm !== undefined ||
        updates.autoBaseBpm !== undefined ||
        updates.autoOffsetBpm !== undefined ||
        updates.maxTempoPercent !== undefined
      ) {
        applyImmediateTempoToPlayingDecks(state);
      }

      // Apply mix check enable/disable immediately.
      // Keep the automix trigger in sync immediately when timing/energy/tempo changes.
      if (state.isPartyMode && (
        updates.endEarlySeconds !== undefined ||
        updates.crossfadeSeconds !== undefined ||
        updates.tempoMode !== undefined ||
        updates.tempoPreset !== undefined ||
        updates.lockedBpm !== undefined ||
        updates.autoBaseBpm !== undefined ||
        updates.autoOffsetBpm !== undefined ||
        updates.maxTempoPercent !== undefined ||
        updates.repeatMode !== undefined
      )) {
        if (state.settings.repeatMode === 'track') {
          // Repeat Track should never schedule/trigger a next-track mix.
          audioEngine.enableMixCheck(false);
          audioEngine.resetMixTrigger();
        } else {
          // Re-evaluate immediately using the new threshold.
          armAutoMixTriggerForState(get());
        }
      }

      if (enablingRepeatTrack) {
        // Hard restart the same song and keep index stable.
        get().restartCurrentTrack({ reason: 'repeat_enabled' });
      }

      // Apply audio engine settings
      if (updates.masterVolume !== undefined) {
        audioEngine.setMasterVolume(clamp(updates.masterVolume, 0, 1));
      }
      if (updates.limiterEnabled !== undefined) {
        audioEngine.setLimiterEnabled(updates.limiterEnabled);
      }
      if (updates.limiterStrength !== undefined) {
        audioEngine.setLimiterStrength(updates.limiterStrength);
      }
      if (updates.vibesPreset !== undefined) {
        audioEngine.setVibesPreset(updates.vibesPreset);
      }

      // Persist settings with a short debounce to prevent IDB write races
      // when controls update rapidly (e.g. sliders).
      queuedSettingsUpdates = { ...queuedSettingsUpdates, ...updates };
      if (settingsSaveTimeout !== null) {
        clearTimeout(settingsSaveTimeout);
      }
      settingsSaveTimeout = setTimeout(() => {
        const toSave = queuedSettingsUpdates;
        queuedSettingsUpdates = {};
        settingsSaveTimeout = null;

        void updateSettings(toSave).catch((error) => {
          console.error('[DJ Store] Failed to persist settings:', error);
        });
      }, 150);
    },

    createPlaylist: async (name: string) => {
      const playlist: Playlist = {
        id: generateId(),
        name,
        trackIds: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await addPlaylist(playlist);
      set(state => ({ playlists: [...state.playlists, playlist] }));
    },

    addTrackToPlaylist: async (playlistId: string, trackId: string) => {
      const playlist = get().playlists.find(p => p.id === playlistId);
      if (!playlist) return;

      if (!playlist.trackIds.includes(trackId)) {
        const newTrackIds = [...playlist.trackIds, trackId];
        await updatePlaylist(playlistId, { trackIds: newTrackIds });
        set(state => ({
          playlists: state.playlists.map(p =>
            p.id === playlistId ? { ...p, trackIds: newTrackIds } : p
          ),
        }));
      }

      const state = get();
      const shouldShuffleUpcomingNow =
        state.isPartyMode &&
        state.settings.shuffleEnabled &&
        state.partySource?.type === 'playlist' &&
        state.partySource.playlistId === playlistId &&
        state.partyTrackIds.length > 1;

      if (shouldShuffleUpcomingNow) get().shufflePartyTracks();
    },

    removeTrackFromPlaylist: async (playlistId: string, trackId: string) => {
      // Back-compat: treat as "remove from this playlist" with queue + currently-playing handling.
      await get().removeFromPlaylist(playlistId, trackId);
    },

    clearPlaylistTracks: async (playlistId: string) => {
      const stateBefore = get();
      const playlist = stateBefore.playlists.find((p) => p.id === playlistId);
      if (!playlist) return;
      if (playlist.trackIds.length === 0) return;

      await updatePlaylist(playlistId, {trackIds: []});
      set((state) => ({
        playlists: state.playlists.map((p) => (p.id === playlistId ? {...p, trackIds: []} : p)),
      }));

      const stateMid = get();
      if (stateMid.isPartyMode && stateMid.partySource?.type === 'playlist' && stateMid.partySource.playlistId === playlistId) {
        // Clearing the active playlist source implies there is nothing left to play.
        get().stopPartyMode();
      }

      toast({
        title: 'Playlist cleared',
        description: `Removed all tracks from "${playlist.name}".`,
      });
    },

    reorderPlaylistTracks: async (playlistId: string, fromIndex: number, toIndex: number) => {
      const playlist = get().playlists.find(p => p.id === playlistId);
      if (!playlist) return;

      const newTrackIds = [...playlist.trackIds];
      const [removed] = newTrackIds.splice(fromIndex, 1);
      newTrackIds.splice(toIndex, 0, removed);

      await updatePlaylist(playlistId, { trackIds: newTrackIds });
      set(state => ({
        playlists: state.playlists.map(p =>
          p.id === playlistId ? { ...p, trackIds: newTrackIds } : p
        ),
      }));
    },

    deletePlaylistById: async (id: string) => {
      await deletePlaylist(id);
      set(state => ({ playlists: state.playlists.filter(p => p.id !== id) }));
    },

    // Helper methods
    getPartyTracks: () => {
      const state = get();
      return state.partyTrackIds
        .map(id => state.tracks.find(t => t.id === id))
        .filter(Boolean) as Track[];
    },

    getCurrentTrack: () => {
      const state = get();
      const currentTrackId = state.partyTrackIds[state.nowPlayingIndex];
      return state.tracks.find(t => t.id === currentTrackId);
    },

    getUpcomingTracks: () => {
      const state = get();
      return state.partyTrackIds
        .slice(state.nowPlayingIndex + 1)
        .map(id => state.tracks.find(t => t.id === id))
        .filter(Boolean) as Track[];
    },
  };
    },
    {
      name: 'mejay:djStore',
      version: 1,
      storage: createJSONStorage(() => getDjSessionStorage() ?? djStoreNoopStorage),
      partialize: (state) => ({
        // Deck state: persist only what can be safely/consistently restored.
        deckA: {
          trackId: state.deckA.trackId,
          playbackRate: state.deckA.playbackRate,
        },
        deckB: {
          trackId: state.deckB.trackId,
          playbackRate: state.deckB.playbackRate,
        },

        activeDeck: state.activeDeck,
        isPartyMode: state.isPartyMode,
        partySource: state.partySource,
        partyTrackIds: state.partyTrackIds,
        nowPlayingIndex: state.nowPlayingIndex,
        pendingNextIndex: state.pendingNextIndex,
        pendingSourceSwitch: state.pendingSourceSwitch,
        queuedSourceSwitch: state.queuedSourceSwitch,
        crossfadeValue: state.crossfadeValue,

        // User settings are small and serializable.
        settings: state.settings,
      }),
      // Ensure nested objects (deckA/deckB) merge instead of replacing.
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<DJState>;
        return {
          ...currentState,
          ...persisted,
          deckA: { ...currentState.deckA, ...(persisted.deckA ?? {}) },
          deckB: { ...currentState.deckB, ...(persisted.deckB ?? {}) },
        } as DJState;
      },
    }
  )
);
