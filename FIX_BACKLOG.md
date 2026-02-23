# MeJay Fix Backlog

**Date:** 2026-02-23  
**Total Issues:** 14 (3 Critical, 5 High, 4 Medium, 2 Low)  
**Phase 1 Scope:** Guard rails only (Priority 1 + selective Priority 2)  
**Phase 2+:** Full state machine + mutex (out of scope for now)

---

## CRITICAL (Blocker-Level)

### 🔴 #1: Race Condition in play() vs playAt()
**File:** `src/lib/audioEngine.ts` (lines ~700-800)  
**Severity:** CRITICAL  
**Impact:** Memory leaks, audio glitches, concurrent source nodes  
**Root Cause:** Both methods can be called without synchronization; old nodes left playing

**Symptom:**
```
User clicks play → play() creates source node A
User clicks play again immediately → play() creates source node B
Result: A and B both play simultaneously, audio distorts, nodes not cleaned up
```

**Phase 1 Fix:**
- Add `DeckState` enum with EMPTY/LOADING/READY/PLAYING/STOPPED
- Guard: play/playAt only allowed if state === READY or PLAYING
- Pattern: Check state before creating new source node

**Phase 2+ Fix:**
- Queue: All play/stop/seek ops queued per deck, serialize execution

**Acceptance Test:**
```
Rapid play/pause 100x in 2 seconds
Expected: No glitches, no source node leaks, clean audio
```

---

### 🔴 #2: Integer Overflow in Tempo Ramp
**File:** `src/lib/audioEngine.ts` (lines ~350-400, updateTrackPositionTo method)  
**Severity:** CRITICAL  
**Impact:** 6+ hour DJ sets reset mid-track  
**Root Cause:** No bounds check on `trackAtLastCtx` accumulation

**Symptom:**
```
After 6 hours of continuous playback with tempo ramping:
trackAtLastCtx += integral  // No check if this exceeds duration
Result: Playback position wraps or becomes undefined
```

**Phase 1 Fix:**
- Clamp: `trackAtLastCtx = Math.min(duration, trackAtLastCtx + integral)`
- Validate: If trackAtLastCtx > duration, log warning and reset to duration

**Phase 2+ Fix:**
- Refactor: Use a modulo-based position tracker with explicit bounds

**Acceptance Test:**
```
Simulate 8-hour set (speed up time with multiplier)
Expected: No position resets, smooth transitions throughout
```

---

### 🔴 #3: BPM Detection Returns Infinity
**File:** `src/lib/bpmDetector.ts` (lines ~50-100, findBPM function)  
**Severity:** CRITICAL  
**Impact:** Auto-sync stalls, beat grid breaks, mix trigger hangs  
**Root Cause:** No guard against `60 / bestBucket` when bestBucket = 0

**Symptom:**
```
detectBPM(silentAudio) → findBPM() → bestBucket = 0 → bpm = 60 / 0 = Infinity
Later: getNextBeatTime() uses bpm → 60 / Infinity = 0 → divide by zero
```

**Phase 1 Fix:**
```typescript
if (bestBucket === 0 || !Number.isFinite(bestBucket)) {
  return { bpm: 0, confidence: 0 };
}
const bpm = 60 / bestBucket;
if (!Number.isFinite(bpm) || bpm <= 0) {
  return { bpm: 0, confidence: 0 };
}
```

**Phase 2+ Fix:**
- Confidence thresholding: Only return BPM if confidence > 0.3

**Acceptance Test:**
```
Load: Silent audio, white noise, very low bitrate
Expected: Zero BPM returned (not Infinity), no downstream errors
```

---

## HIGH (Affects Stability)

### 🟠 #4: Division by Zero in getNextBeatTime()
**File:** `src/lib/audioEngine.ts` (lines ~430-450)  
**Severity:** HIGH  
**Impact:** Beat alignment UI breaks, crossfade timing wrong  
**Root Cause:** No check for bpm === 0 before division

**Phase 1 Fix:**
```typescript
if (!bpm || bpm <= 0) return this.audioContext.currentTime;
```

---

### 🟠 #5: No Validation of Audio Buffer Duration
**File:** `src/lib/audioEngine.ts` (lines ~670-700, loadTrack method)  
**Severity:** HIGH  
**Impact:** Zero-duration audio silently loads, playback undefined  
**Root Cause:** audioBuffer.duration not validated after decode

**Phase 1 Fix:**
```typescript
const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
if (!Number.isFinite(audioBuffer.duration) || audioBuffer.duration <= 0) {
  throw new Error('Invalid audio buffer: duration must be > 0');
}
```

**Acceptance Test:**
```
Import: Corrupt file, zero-byte file, metadata-only file
Expected: Clean error message (not silent fail)
```

---

### 🟠 #6: Unhandled Promise in analyzeLoudness()
**File:** `src/lib/audioEngine.ts` (lines ~715)  
**Severity:** HIGH  
**Impact:** Silent failure of volume analysis, no user feedback  
**Root Cause:** No try/catch around decodeAudioData

**Phase 1 Fix:**
```typescript
async analyzeLoudness(blob: Blob): Promise<{ loudnessDb: number; gainDb: number }> {
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
    // ...
  } catch (error) {
    console.warn('[analyzeLoudness] Failed:', error);
    return { loudnessDb: -14, gainDb: 0 };  // Sensible default
  }
}
```

---

### 🟠 #7: Ramp Timing Silently Shifted Forward
**File:** `src/lib/audioEngine.ts` (lines ~900-920, rampTempo method)  
**Severity:** HIGH  
**Impact:** Crossfade/tempo ramps start late, timing-sensitive mixes slip  
**Root Cause:** startAtTime in past is silently adjusted; no warning

**Phase 1 Fix:**
```typescript
if (startAtTime < this.audioContext.currentTime) {
  console.warn(
    `[rampTempo] startAtTime (${startAtTime}) is in the past; ` +
    `adjusting to now (${this.audioContext.currentTime})`
  );
}
```

---

### 🟠 #8: Limiter Bypass Doesn't Actually Bypass
**File:** `src/lib/audioEngine.ts` (lines ~555-575, updateLimiter method)  
**Severity:** HIGH  
**Impact:** Users expecting limiter bypass still get compression  
**Root Cause:** Setting ratio=1 doesn't bypass; just reduces compression

**Phase 1 Fix (Lightweight):**
```typescript
if (!this.limiterEnabled) {
  // Store bypass flag, check it in setLimiterEnabled
  this.limiterNode.threshold.value = 0;
  this.limiterNode.ratio.value = 1;
}
// TODO Phase 2: Proper routing (disconnect or conditional chain)
```

**Phase 2+ Fix:**
- Disconnect limiter from chain when disabled
- Or: Use conditional gain routing

---

## MEDIUM (Polish + Robustness)

### 🟡 #9: Memory Leak: Scheduled Timeouts Not Cleared
**File:** `src/lib/audioEngine.ts` (lines ~210-240, clearScheduledStart method)  
**Severity:** MEDIUM  
**Impact:** Minor memory leaks in long-running sessions  
**Root Cause:** If playAt() called multiple times, timeouts accumulate

**Phase 1 Fix:**
- Already called in stop(); verify all code paths call clearScheduledStart

**Phase 2+ Fix:**
- Use AbortController for timeout management

---

### 🟡 #10: Low-Pass Filter Buffer Bounds
**File:** `src/lib/bpmDetector.ts` (lines ~40)  
**Severity:** MEDIUM  
**Impact:** Potential buffer overflow or incorrect peak detection on non-standard sample rates  
**Root Cause:** Window math doesn't guard against bounds

**Phase 1 Fix:**
- Add assertions: `j >= 0 && j < data.length`

---

### 🟡 #11: Tempo Percent Rounding Edge Cases
**File:** `src/lib/tempoMatch.ts` (lines ~25-30)  
**Severity:** MEDIUM  
**Impact:** Extremely small tempo adjustments (<0.01%) silently rounded away  
**Root Cause:** No guard against Infinity in normalizeTempoPct

**Phase 1 Fix:**
```typescript
if (!Number.isFinite(value)) return 0;
```

---

### 🟡 #12: Silent Gain Application Failures
**File:** `src/lib/audioEngine.ts` (lines ~745, setTrackGain method)  
**Severity:** MEDIUM  
**Impact:** Users unaware if automatic gain matching fails  
**Root Cause:** try/catch swallows error silently

**Phase 1 Fix:**
```typescript
} catch (error) {
  console.warn('[setTrackGain] Scheduled ramp failed, applying immediate gain:', error);
  deckState.trackGainNode.gain.value = linearGain;
}
```

---

## LOW (Nice-to-Have)

### 🟢 #13: BPM Setter No Input Validation
**File:** `src/lib/audioEngine.ts` (lines ~565, setBaseBpm method)  
**Severity:** LOW  
**Impact:** Internal API misuse cascades to other methods  
**Root Cause:** No range check on bpm parameter

**Phase 1 Fix:**
```typescript
setBaseBpm(deck: DeckId, bpm: number): void {
  if (Number.isFinite(bpm) && bpm > 0) {
    this.decks[deck].baseBpm = bpm;
  } else {
    console.warn('[setBaseBpm] Invalid BPM:', bpm);
    this.decks[deck].baseBpm = 120;  // Safe default
  }
}
```

---

### 🟢 #14: Confidence Score Exceeds 1.0
**File:** `src/lib/bpmDetector.ts` (lines ~105)  
**Severity:** LOW  
**Impact:** Minor UI glitches (confidence > 100%), no audio impact  
**Root Cause:** No clamp on confidence calculation

**Phase 1 Fix:**
```typescript
const confidence = Math.min(1, maxCount / intervals.length);
```

---

## Phase 1 Inclusion Criteria

| Issue | Severity | Included in Phase 1? | Reason |
|-------|----------|----------------------|--------|
| #1 (Race condition) | CRITICAL | ✅ YES | State enum guards |
| #2 (Overflow) | CRITICAL | ✅ YES | Clamp + bounds |
| #3 (BPM Infinity) | CRITICAL | ✅ YES | Guard against Infinity |
| #4 (Division by zero) | HIGH | ✅ YES | BPM > 0 check |
| #5 (Buffer validation) | HIGH | ✅ YES | Duration > 0 check |
| #6 (Promise rejection) | HIGH | ✅ YES | Try/catch + default |
| #7 (Ramp shifted) | HIGH | 🟡 MAYBE | Logging only, no patch |
| #8 (Limiter bypass) | HIGH | ✅ YES | Lightweight flag |
| #9 (Timeout leak) | MEDIUM | ✅ YES | Verify cleanup |
| #10 (Buffer bounds) | MEDIUM | 🟡 MAYBE | Low impact |
| #11 (Rounding) | MEDIUM | 🟡 MAYBE | Low impact |
| #12 (Gain fail) | MEDIUM | ✅ YES | Add logging |
| #13 (BPM setter) | LOW | ✅ YES | Cheap safeguard |
| #14 (Confidence) | LOW | ✅ YES | Cheap clamp |

---

## Phase 1 Priority Roadmap

**Priority 1 (State Machine + Guards):**
- Issue #1, #3, #4, #5 — Core guard rails

**Priority 2 (Input Validation + Logging):**
- Issue #6, #12, #13, #14 — Observability + validation

**Priority 3 (Cleanup + Bounds):**
- Issue #2, #8, #9 — Cleanup discipline + edge cases

**Defer to Phase 2+:**
- Mutex/queue patterns
- Full state machine refactoring
- Conditional audio routing

---

## Acceptance Criteria for Phase 1 Complete

- [ ] State enum introduced (EMPTY → LOADING → READY → PLAYING → STOPPED)
- [ ] play/playAt guarded by state check
- [ ] All BPM calculations guarded against zero/Infinity
- [ ] Audio buffer duration validated on load
- [ ] All critical cleanup paths null out nodes
- [ ] Logging added (dev-mode only, no spam)
- [ ] Rapid skip spam test passes (100x play/pause)
- [ ] Zero-duration audio handled gracefully
- [ ] Crossfade + load concurrent test passes

---

## Notes for Horizon

**Phase 1 Goal:** Guard rails, not rewrites. Stop when ambiguity disappears.

**Do Not Include:**
- ❌ Full state machine
- ❌ Mutex/queue
- ❌ Audio node lifecycle refactor
- ❌ New abstractions

**Do Include:**
- ✅ Enum + guards
- ✅ Input validation (BPM, duration)
- ✅ Explicit cleanup
- ✅ Structured logging
- ✅ Bounds checks

---

**Status:** 🟡 Awaiting Approval (Phase 1 Fix Backlog)  
**Owner:** John Steele  
**Next:** FIX_PLAN_v1.md (if Phase 1 scope approved)
