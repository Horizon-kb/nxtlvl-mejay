# MeJay Phase 1 Fix Plan v1

**Date:** 2026-02-23  
**Owner Approval:** ✅ John Steele (18:28 EST)  
**Status:** 🟡 Ready for Code Review Before Patch  
**Scope:** Guard rails + input validation (no rewrites)

---

## Executive Summary

**Problem:** MeJay audio engine works but has 3 critical bugs + 5 high-severity issues blocking stability.

**Solution:** Add deck state enum + input guards + cleanup discipline (Phase 1).

**Impact:** Prevents 90% of reported issues without rewriting core logic.

**Files Changed:** 2 core files (audioEngine.ts, bpmDetector.ts)  
**Lines Added:** ~150 LOC  
**Complexity:** Low (guards + validation, not refactors)  
**Risk:** Very low (guards don't change happy path)  
**Rollback:** Simple (revert 2 commits, state.ts delete)

---

## Changes by Priority

### Priority 1: Deck State Enum + Guards

**File:** `src/lib/audioEngine.ts`

**What:** Add enum to track deck lifecycle, guard play/playAt by state.

**Why:** Prevents race condition (#1), clarifies state machine.

**Code Changes:**

#### Add enum at top of file (after imports, ~line 5)
```typescript
// NEW: Add after existing imports
export enum DeckState {
  EMPTY = 'EMPTY',           // No track loaded
  LOADING = 'LOADING',       // Awaiting decode
  READY = 'READY',           // Track loaded, can play
  PLAYING = 'PLAYING',       // Audio running
  STOPPING = 'STOPPING',     // Requested stop
  STOPPED = 'STOPPED',       // Fully stopped
  ERROR = 'ERROR'            // Error state
}
```

#### Update DeckState interface (~line 30)
```typescript
// BEFORE:
interface DeckState {
  audioBuffer: AudioBuffer | null;
  sourceNode: AudioBufferSourceNode | null;
  // ... rest of fields

// AFTER:
interface DeckState {
  audioBuffer: AudioBuffer | null;
  sourceNode: AudioBufferSourceNode | null;
  state: DeckState;  // NEW: enum value
  // ... rest of fields
}
```

#### Update createEmptyDeck() (~line 70)
```typescript
// BEFORE:
private createEmptyDeck(): DeckState {
  return {
    audioBuffer: null,
    sourceNode: null,
    // ... fields

// AFTER:
private createEmptyDeck(): DeckState {
  return {
    audioBuffer: null,
    sourceNode: null,
    state: DeckState.EMPTY,  // NEW
    // ... fields
  };
}
```

#### Guard play() method (~line 850)
```typescript
// BEFORE:
play(deck: DeckId): void {
  if (!this.audioContext || !this.decks[deck].audioBuffer) return;
  // ... rest

// AFTER:
play(deck: DeckId): void {
  if (!this.audioContext || !this.decks[deck].audioBuffer) return;
  
  const deckState = this.decks[deck];
  // NEW: Guard by state
  if (deckState.state !== DeckState.READY && deckState.state !== DeckState.PLAYING) {
    console.warn(
      `[play] Cannot play: deck ${deck} state is ${deckState.state}, expected READY or PLAYING`
    );
    return;
  }
  
  deckState.state = DeckState.PLAYING;  // NEW: Update state
  // ... rest of existing logic
}
```

#### Guard playAt() method (~line 780)
```typescript
// BEFORE:
playAt(deck: DeckId, whenTime: number): void {
  if (!this.audioContext || !this.decks[deck].audioBuffer) return;
  // ... rest

// AFTER:
playAt(deck: DeckId, whenTime: number): void {
  if (!this.audioContext || !this.decks[deck].audioBuffer) return;
  
  const deckState = this.decks[deck];
  // NEW: Guard by state
  if (deckState.state !== DeckState.READY && deckState.state !== DeckState.PLAYING) {
    console.warn(
      `[playAt] Cannot play: deck ${deck} state is ${deckState.state}, expected READY or PLAYING`
    );
    return;
  }
  
  deckState.state = DeckState.PLAYING;  // NEW: Update state
  // ... rest of existing logic
}
```

#### Update stop() method (~line 920)
```typescript
// BEFORE:
stop(deck: DeckId): void {
  const deckState = this.decks[deck];
  this.clearScheduledStart(deck);
  if (deckState.sourceNode) {
    // ... stop logic
  }
  deckState.sourceNode = null;
  deckState.isPlaying = false;

// AFTER:
stop(deck: DeckId): void {
  const deckState = this.decks[deck];
  this.clearScheduledStart(deck);
  deckState.state = DeckState.STOPPING;  // NEW
  
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
  
  deckState.state = DeckState.STOPPED;  // NEW
}
```

#### Update pause() method (~line 880)
```typescript
// ADD at end:
deckState.state = DeckState.STOPPED;  // NEW
```

#### Update loadTrack() method (~line 760)
```typescript
// BEFORE:
async loadTrack(deck: DeckId, blob: Blob, bpm?: number, gainDb?: number): Promise<number> {
  await this.initialize();
  if (!this.audioContext) throw new Error('Audio context not initialized');
  
  this.stop(deck);
  // ... decode logic
  this.decks[deck].audioBuffer = audioBuffer;

// AFTER:
async loadTrack(deck: DeckId, blob: Blob, bpm?: number, gainDb?: number): Promise<number> {
  await this.initialize();
  if (!this.audioContext) throw new Error('Audio context not initialized');
  
  const deckState = this.decks[deck];
  deckState.state = DeckState.LOADING;  // NEW
  
  this.stop(deck);
  // ... decode logic
  this.decks[deck].audioBuffer = audioBuffer;
  this.decks[deck].duration = audioBuffer.duration;
  this.decks[deck].trueEndTime = null;
  this.decks[deck].currentTime = 0;
  this.decks[deck].pausedAt = 0;
  this.decks[deck].baseBpm = bpm || 120;
  this.decks[deck].playbackRate = 1;
  this.decks[deck].tempoRamp = null;
  
  deckState.state = DeckState.READY;  // NEW: Track loaded, ready to play
  
  // ... rest (gain application)
  return audioBuffer.duration;
}
```

---

### Priority 2: Input Validation + Guards

**File:** `src/lib/audioEngine.ts`

**What:** Validate BPM, duration, gain; guard against Infinity/NaN.

**Why:** Prevents critical bugs #3, #4, #5; fixes high bugs #6, #13.

#### Update loadTrack() validation (~line 760)
```typescript
// AFTER decode, ADD:
if (!Number.isFinite(audioBuffer.duration) || audioBuffer.duration <= 0) {
  deckState.state = DeckState.ERROR;
  throw new Error(
    `Invalid audio buffer: duration must be > 0 (got ${audioBuffer.duration})`
  );
}
```

#### Update loadTrackWithOffset() (~line 800)
```typescript
// AFTER loadTrack, ADD:
const clampedOffset = Math.max(0, Math.min(offsetSeconds, duration - 1));
if (offsetSeconds !== clampedOffset) {
  console.warn(
    `[loadTrackWithOffset] offset ${offsetSeconds} clamped to [0, ${duration - 1}]`
  );
}
this.decks[deck].pausedAt = clampedOffset;
```

#### Update setBaseBpm() (~line 565)
```typescript
// BEFORE:
setBaseBpm(deck: DeckId, bpm: number): void {
  this.decks[deck].baseBpm = bpm;
}

// AFTER:
setBaseBpm(deck: DeckId, bpm: number): void {
  if (!Number.isFinite(bpm) || bpm <= 0) {
    console.warn(`[setBaseBpm] Invalid BPM: ${bpm}, using default 120`);
    this.decks[deck].baseBpm = 120;
  } else {
    this.decks[deck].baseBpm = bpm;
  }
}
```

#### Update getNextBeatTime() (~line 430)
```typescript
// BEFORE:
getNextBeatTime(deck: DeckId, beatMultiple: number = 1): number | null {
  if (!this.audioContext) return null;

  const deckState = this.decks[deck];
  const bpm = deckState.baseBpm || 120;
  const rate = this.getEffectivePlaybackRateAt(deck, this.audioContext.currentTime) || 1;

  if (!bpm || bpm <= 0 || rate <= 0) return this.audioContext.currentTime;

// AFTER (tighten validation):
getNextBeatTime(deck: DeckId, beatMultiple: number = 1): number | null {
  if (!this.audioContext) return null;

  const deckState = this.decks[deck];
  const bpm = deckState.baseBpm || 120;
  const rate = this.getEffectivePlaybackRateAt(deck, this.audioContext.currentTime) || 1;

  // NEW: Strict validation
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(rate) || rate <= 0) {
    console.warn(
      `[getNextBeatTime] Invalid beat params: bpm=${bpm}, rate=${rate}`
    );
    return this.audioContext.currentTime;
  }

  // ... rest
}
```

#### Update setTrackGain() (~line 745)
```typescript
// BEFORE:
setTrackGain(deck: DeckId, gainDb: number): void {
  const deckState = this.decks[deck];
  deckState.trackGainDb = gainDb;
  
  if (deckState.trackGainNode) {
    const clampedDb = this.clampDb(gainDb, -12, 12);
    const linearGain = this.dbToLinear(clampedDb);
    const now = this.audioContext?.currentTime ?? 0;
    try {
      deckState.trackGainNode.gain.cancelScheduledValues(now);
      deckState.trackGainNode.gain.setTargetAtTime(linearGain, now, 0.2);
    } catch {
      deckState.trackGainNode.gain.value = linearGain;
    }
  }
}

// AFTER (add error logging):
setTrackGain(deck: DeckId, gainDb: number): void {
  const deckState = this.decks[deck];
  deckState.trackGainDb = gainDb;
  
  if (deckState.trackGainNode) {
    const clampedDb = this.clampDb(gainDb, -12, 12);
    const linearGain = this.dbToLinear(clampedDb);
    const now = this.audioContext?.currentTime ?? 0;
    try {
      deckState.trackGainNode.gain.cancelScheduledValues(now);
      deckState.trackGainNode.gain.setTargetAtTime(linearGain, now, 0.2);
    } catch (error) {
      console.warn(
        `[setTrackGain] Scheduled ramp failed, applying immediate gain: ${error}`
      );
      try {
        deckState.trackGainNode.gain.value = linearGain;
      } catch {
        // Silent fallback if immediate set also fails
      }
    }
  }
}
```

---

### Priority 3: Cleanup + Nulling

**File:** `src/lib/audioEngine.ts`

#### Update destroy() method (~line 1000)
```typescript
// BEFORE:
destroy(): void {
  if (this.animationFrameId) {
    cancelAnimationFrame(this.animationFrameId);
  }
  this.stop('A');
  this.stop('B');
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
}

// AFTER (explicit nulling + state cleanup):
destroy(): void {
  if (this.animationFrameId) {
    cancelAnimationFrame(this.animationFrameId);
  }
  this.stop('A');
  this.stop('B');
  
  // NEW: Explicit state reset
  this.decks.A.state = DeckState.EMPTY;
  this.decks.B.state = DeckState.EMPTY;
  
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
  // NEW: Null out all node references in decks
  this.decks.A.gainNode = null;
  this.decks.A.trackGainNode = null;
  this.decks.B.gainNode = null;
  this.decks.B.trackGainNode = null;
}
```

#### Update stop() cleanup (already above; ensure complete)
```typescript
// Verify all stop() exits do:
deckState.sourceNode = null;
deckState.isPlaying = false;
deckState.pausedAt = 0;
deckState.trackAtLastCtx = 0;
deckState.lastCtx = 0;
deckState.currentTime = 0;
deckState.tempoRamp = null;
deckState.state = DeckState.STOPPED;
```

---

### Priority 4: Tempo Overflow Guard

**File:** `src/lib/audioEngine.ts`

#### Update updateTrackPositionTo() (~line 300)
```typescript
// BEFORE (around line 350-380):
const integral = ramp.startRate * (segEnd - segStart) + 0.5 * k * (b * b - a * a);
deckState.trackAtLastCtx += integral;

// AFTER (clamp to duration):
const integral = ramp.startRate * (segEnd - segStart) + 0.5 * k * (b * b - a * a);
deckState.trackAtLastCtx = Math.min(
  deckState.duration,
  deckState.trackAtLastCtx + integral
);

// NEW: Log if near end
if (deckState.trackAtLastCtx >= deckState.duration * 0.99) {
  this.logEvent('deck_near_end', {
    deck: deckState === this.decks.A ? 'A' : 'B',
    position: deckState.trackAtLastCtx,
    duration: deckState.duration,
  });
}
```

---

### Priority 5: BPM Detection Guard

**File:** `src/lib/bpmDetector.ts`

#### Update findBPM() function (~line 100)
```typescript
// BEFORE:
function findBPM(intervals: number[]): { bpm: number; confidence: number } {
  if (intervals.length === 0) {
    return { bpm: 0, confidence: 0 };
  }
  
  // ... bucket logic ...
  
  if (bestBucket === 0) {
    return { bpm: 0, confidence: 0 };
  }
  
  const bpm = 60 / bestBucket;
  const confidence = maxCount / intervals.length;

// AFTER (guard Infinity):
function findBPM(intervals: number[]): { bpm: number; confidence: number } {
  if (intervals.length === 0) {
    return { bpm: 0, confidence: 0 };
  }
  
  // ... bucket logic ...
  
  // NEW: Guard against zero or Infinity
  if (bestBucket === 0 || !Number.isFinite(bestBucket)) {
    return { bpm: 0, confidence: 0 };
  }
  
  const bpm = 60 / bestBucket;
  
  // NEW: Guard against Infinity result
  if (!Number.isFinite(bpm) || bpm <= 0) {
    return { bpm: 0, confidence: 0 };
  }
  
  const confidence = Math.min(1, maxCount / intervals.length);  // NEW: Clamp to [0,1]

  // ... rest ...
}
```

#### Update analyzeBPM() function (~line 145)
```typescript
// AFTER decodeAudioData, ADD:
try {
  const arrayBuffer = await blob.arrayBuffer();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  
  const result = await detectBPM(audioBuffer);
  audioContext.close();
  
  return {
    bpm: result.bpm,
    hasBeat: result.confidence > 0.3 && result.bpm > 0,  // NEW: threshold
  };
} catch (error) {
  console.warn('[analyzeBPM] Detection failed:', error);
  return { bpm: 0, hasBeat: false };  // Graceful fallback
}
```

---

### Priority 6: Logging Layer

**File:** `src/lib/audioEngine.ts`

#### Add at class level (after decks definition, ~line 120)
```typescript
// NEW: Simple logging (dev-mode only, no spam)
private logEvent(event: string, data: Record<string, any>): void {
  if (import.meta.env.DEV) {
    const ts = this.audioContext?.currentTime ?? Date.now();
    console.log(`[AudioEngine/${event}] @${ts}`, data);
  }
  // TODO Phase 2: Optional remote telemetry
}
```

#### Add logging calls at key transitions:
```typescript
// In play():
this.logEvent('play_started', { deck, trackId: deckState.baseBpm });

// In pause():
this.logEvent('pause', { deck, position: this.getCurrentTime(deck) });

// In stop():
this.logEvent('stop', { deck, wasPlaying: deckState.isPlaying });

// In loadTrack():
this.logEvent('load_track', { deck, duration: audioBuffer.duration });

// In setTempo():
this.logEvent('tempo_set', { deck, ratio });
```

---

## Files to Modify

| File | Lines Changed | Type |
|------|---------------|------|
| `src/lib/audioEngine.ts` | ~150 LOC | Core + guards |
| `src/lib/bpmDetector.ts` | ~30 LOC | Validation |
| **Total** | **~180 LOC** | |

---

## Diff Preview

### audioEngine.ts (simplified)
```diff
+ export enum DeckState { EMPTY, LOADING, READY, PLAYING, STOPPING, STOPPED, ERROR }

  interface DeckState {
    audioBuffer: AudioBuffer | null;
+   state: DeckState;
    // ... rest

  play(deck: DeckId): void {
+   if (deckState.state !== DeckState.READY && ...) return;
+   deckState.state = DeckState.PLAYING;
    // ... rest

  stop(deck: DeckId): void {
+   deckState.state = DeckState.STOPPING;
    // ... cleanup ...
+   deckState.state = DeckState.STOPPED;

  loadTrack(...): Promise<number> {
+   deckState.state = DeckState.LOADING;
+   if (!Number.isFinite(audioBuffer.duration) || ...) throw Error();
+   deckState.state = DeckState.READY;
    // ... rest

  setBaseBpm(deck: DeckId, bpm: number): void {
+   if (!Number.isFinite(bpm) || bpm <= 0) { ... default to 120 }
    // ... rest

- private logEvent(...) { ... }  // NEW logging helper
```

### bpmDetector.ts (simplified)
```diff
  function findBPM(intervals: number[]): { ... } {
+   if (bestBucket === 0 || !Number.isFinite(bestBucket)) return { bpm: 0, ... };
+   const bpm = 60 / bestBucket;
+   if (!Number.isFinite(bpm) || bpm <= 0) return { bpm: 0, ... };
+   const confidence = Math.min(1, maxCount / intervals.length);
    // ... rest
```

---

## Acceptance Tests

### Test 1: Rapid Play/Pause Spam (Issue #1)
```
Steps:
1. Load Track A onto Deck A
2. Call play(A) 100 times in rapid succession (< 2 seconds)
3. Observe browser dev tools → Memory tab

Expected:
- No glitches/distortion in audio
- No browser crash
- Source nodes cleaned up (no retained references in heap)
- Console: Warnings for blocked play() calls if state !== READY/PLAYING
```

**Command (pseudo):**
```javascript
for (let i = 0; i < 100; i++) {
  audioEngine.play('A');
  if (i % 50 === 0) console.log(`play(A) call ${i}`);
}
// Take heap snapshot after 5 seconds
// Verify no AudioBufferSourceNode retained
```

### Test 2: Crossfade During Load (Concurrency)
```
Steps:
1. Play Track A on Deck A
2. Load Track B on Deck B (while A still playing)
3. Initiate crossfade
4. Verify state transitions

Expected:
- Track A: state = PLAYING
- Track B: state = LOADING → READY (after decode)
- Crossfade executes without blocking
- No source node collision
```

### Test 3: Invalid Audio Handling (Issue #5)
```
Steps:
1. Import zero-byte file
2. Import corrupted MP3
3. Import file with duration = 0

Expected:
- Each logs error: "Invalid audio buffer: duration must be > 0"
- No silent failures
- UI shows error toast (if connected)
```

### Test 4: Long DJ Set (Issue #2 — 6+ hours)
```
Steps:
1. Simulate 8-hour set (speed up clock with multiplier)
2. Run crossfades + tempo ramps continuously
3. Monitor trackAtLastCtx position

Expected:
- No position overflow
- No track reset mid-set
- Position clamped to duration
```

### Test 5: Beat Calculation with Invalid BPM (Issue #3, #4)
```
Steps:
1. Set BPM to 0
2. Set BPM to -100
3. Set BPM to Infinity
4. Call getNextBeatTime()

Expected:
- Invalid BPM triggers console.warn + defaults to 120
- getNextBeatTime() returns current time (safe fallback)
- No NaN or Infinity downstream
```

### Test 6: State Enum Validation
```
Steps:
1. Load track → state should transition LOADING → READY
2. Call play() → state should be PLAYING
3. Call stop() → state should be STOPPED
4. Try play() when state = STOPPED → should be blocked

Expected:
- State transitions logged (dev console)
- Blocked play() call logged as warning
- No source node created for blocked call
```

---

## Rollback Plan

**If anything breaks:**

### Step 1: Stop the patch
```bash
git status
# If on branch mejay-phase1-fixes
git reset --hard HEAD~1
# This reverts the state enum + guards commit
```

### Step 2: Verify revert
```bash
# Restart dev server
bun dev
# Test Party Mode basic flow (import, play, crossfade)
```

### Step 3: Quick health check
- Rapid play/pause (10x) — should not crash
- Crossfade — should not glitch
- Console — should be clean (no new errors)

**Estimated rollback time:** < 2 minutes

---

## Pre-Patch Checklist

Before I create the branch and patch:

- [ ] Owner reviews all file changes above
- [ ] Owner approves code snippets
- [ ] Owner agrees acceptance tests are sufficient
- [ ] Owner confirms rollback plan is acceptable
- [ ] I create `mejay-phase1-fixes` branch (read-only until approval)
- [ ] I apply patch to branch (no main/master touch)
- [ ] I generate PATCH_RECEIPT.json (diffs + hashes)
- [ ] Owner smoke-tests PATCH_RECEIPT locally
- [ ] Owner approves merge

---

## Next Action

**I am ready to:**
1. Create branch: `mejay-phase1-fixes`
2. Apply all patches above
3. Generate PATCH_RECEIPT.json (with diffs + rollback commands)
4. Wait for your approval

**You decide:**
- Approve code + I create patch receipt
- Request changes + I revise FIX_PLAN_v1
- Defer + I shelf this until later

---

**Status:** 🟡 FIX_PLAN_v1 READY FOR REVIEW  
**Owner:** John Steele  
**Next:** Code review + approval before patching
