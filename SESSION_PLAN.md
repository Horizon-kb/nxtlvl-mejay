# MeJay Phase 1 Stabilization — SESSION PLAN

**Date:** 2026-02-23  
**Objective:** Low-risk stability pass (guard rails, not rewrites)  
**Scope:** Read-only exploration + artifact generation  
**Duration:** Assessment phase only (no code changes)

---

## Scope & Constraints

### What This Phase Does
- Audit existing audio engine (audioEngine.ts, bpmDetector.ts)
- Identify low-hanging guard-rail improvements
- Plan state enum + play/playAt protection
- Map cleanup + logging requirements
- **No patches. No installs. No test runs. No dev server.**

### What This Phase Does NOT Do
- ❌ Mutex/queue pattern (Phase 2+)
- ❌ Full state machine refactor
- ❌ Core engine rewrite
- ❌ Dependency updates
- ❌ npm audit fix

### Entry Criteria (Already Met)
- ✅ Code is working in production
- ✅ BUG_REPORT.md exists (14 issues documented)
- ✅ Owner approval to proceed read-only

### Exit Criteria (This Phase)
- ✅ Produce FIX_BACKLOG.md (severity-sorted issues)
- ✅ Produce FIX_PLAN_v1.md (state enum + guards only)
- ✅ Define acceptance tests (rapid ops, no glitch)
- ✅ Get owner approval before touching code

---

## Repo Structure (Read-Only Summary)

**Package Manager:** Bun (not npm)  
**Node Version:** 18+ expected  
**Tech Stack:** React 18 + Vite + TypeScript + Zustand + Web Audio API

**Key Files to Examine:**
```
src/lib/audioEngine.ts          (1,200 LOC — dual-deck playback)
src/lib/bpmDetector.ts          (150 LOC — tempo detection)
src/lib/tempoMatch.ts           (250 LOC — BPM matching logic)
src/stores/djStore.ts           (3,200+ LOC — state + transitions)
src/lib/db.ts                   (400 LOC — IndexedDB persistence)
```

**Key Directories:**
- `src/lib/` — Audio engine, BPM, loudness, tempo logic
- `src/stores/` — Zustand state (djStore + planStore)
- `src/components/` — Party Mode UI (controls, queue)
- `src/engines/` — (Currently empty; future expansion point)
- `test/` — Vitest suites (some tests exist)

---

## Known Issues (From BUG_REPORT.md)

**Critical (3):**
1. Race condition: play() vs playAt() can create concurrent source nodes
2. Integer overflow in tempo ramp calculation (6+ hour sets)
3. BPM detection returns Infinity when peak detection fails

**High (5):**
4. Division by zero in getNextBeatTime when BPM = 0
5. No validation of audio buffer duration (zero-duration silently loads)
6. Unhandled promise rejection in analyzeLoudness()
7. Ramp timing shifted forward without warning
8. Limiter bypass doesn't actually bypass

**Medium (4):**
9. Memory leak: scheduled timeouts not always cleared
10. Low-pass filter buffer bounds issues
11. Tempo percent rounding edge cases
12. Silent gain application failures

**Low (2):**
13. BPM setter has no input validation
14. Confidence score can exceed 1.0

---

## Phase 1 Strategy (Guard Rails Only)

### Priority 1 — State Enum + Guards
**Goal:** Prevent play/playAt race condition + clarify deck lifecycle

**Pattern:**
```typescript
enum DeckState {
  EMPTY = 'EMPTY',           // No track loaded
  LOADING = 'LOADING',       // Awaiting decode
  READY = 'READY',           // Track loaded, can play
  PLAYING = 'PLAYING',       // Audio running
  STOPPING = 'STOPPING',     // Requested stop
  STOPPED = 'STOPPED',       // Fully stopped
  ERROR = 'ERROR'            // Error state
}

// Guard: play() only works if state === READY or PLAYING
if (deckState.state !== 'READY' && deckState.state !== 'PLAYING') {
  console.warn(`Cannot play: deck state is ${deckState.state}`);
  return;
}
```

**Files to Modify:**
- `src/lib/audioEngine.ts` — Add enum, inject state checks
- `src/stores/djStore.ts` — Track deck state alongside playback state

**Acceptance Check:**
- Rapid play/pause (100x in 2 seconds) → no source node leaks
- Concurrent play(A) + play(B) → guarded appropriately per deck

---

### Priority 2 — Cleanup + Null Assignment
**Goal:** Prevent dangling audio node references

**Pattern:**
```typescript
stop(deck: DeckId): void {
  const deckState = this.decks[deck];
  if (deckState.sourceNode) {
    deckState.sourceNode.stop();
    deckState.sourceNode.disconnect();
    deckState.sourceNode = null;  // ← Explicit null
  }
}

destroy(): void {
  // ... null out all nodes at end
  this.masterGain = null;
  this.limiterNode = null;
  this.preLimiterGain = null;
  // etc.
}
```

**Files to Modify:**
- `src/lib/audioEngine.ts` — Explicit nulling in stop/destroy/pause

**Acceptance Check:**
- Dev tools memory profiler shows no retained audio nodes after cleanup

---

### Priority 3 — Input Validation (Lightweight)
**Goal:** Fail fast on invalid BPM, duration, gain values

**Pattern:**
```typescript
setBaseBpm(deck: DeckId, bpm: number): void {
  if (!Number.isFinite(bpm) || bpm <= 0) {
    console.warn(`[setBaseBpm] Invalid BPM: ${bpm}, using default 120`);
    this.decks[deck].baseBpm = 120;
    return;
  }
  this.decks[deck].baseBpm = bpm;
}

async loadTrack(...): Promise<number> {
  // ... decode ...
  if (!Number.isFinite(audioBuffer.duration) || audioBuffer.duration <= 0) {
    throw new Error('Invalid audio buffer: duration must be > 0');
  }
  // ... proceed ...
}
```

**Files to Modify:**
- `src/lib/audioEngine.ts` — Guards on setBaseBpm, loadTrack, setTrackGain
- `src/lib/bpmDetector.ts` — Guard against Infinity in findBPM

**Acceptance Check:**
- Load zero-duration audio → clean error (not silent fail)
- Set BPM to -100 → graceful default (no NaN propagation)

---

### Priority 4 — Structured Logging
**Goal:** Observable deck state transitions (not console spam)

**Pattern:**
```typescript
private logEvent(event: string, data: Record<string, any>): void {
  if (import.meta.env.DEV) {
    console.log(`[AudioEngine] ${event}`, {
      timestamp: this.audioContext?.currentTime ?? Date.now(),
      ...data,
    });
  }
  // TODO: Optional remote telemetry in Phase 2
}

// Usage:
play(deck: DeckId): void {
  this.logEvent('play_requested', { deck, trackId, bpm: this.decks[deck].baseBpm });
  // ...
}
```

**Files to Modify:**
- `src/lib/audioEngine.ts` — Add logEvent calls at key transitions
- No console.spam; only dev-mode logging for now

**Acceptance Check:**
- Dev server shows clean event trace for each deck operation
- No "Let me check…" narration in logs

---

## Acceptance Tests (How to Verify)

After Phase 1 patches apply, confirm:

**Test 1: Rapid Skip Spam**
```
1. Load Track A onto Deck A
2. Click play/pause 100 times in 5 seconds
3. Expected: No glitches, no audio artifacts, no browser crash
```

**Test 2: Concurrent Deck Operations**
```
1. Play Track A on Deck A (deck A in PLAYING state)
2. While A plays, load Track B on Deck B
3. While B loads, call play(B)
4. Expected: Queue handled correctly; no source node collision
```

**Test 3: Crossfade During Load**
```
1. Track A playing
2. Load Track B (while A still in PLAYING)
3. Initiate crossfade
4. Expected: Smooth transition, no clicks/pops
```

**Test 4: Cleanup Verification**
```
1. Load 10 different tracks
2. After each, call stop() explicitly
3. Open Dev Tools → Memory tab → take heap snapshot
4. Expected: Audio nodes cleaned up (no retained references)
```

---

## Artifacts to Produce (This Phase)

After read-only assessment:

1. **REPO_MAP.json** — Directory structure + entry points
2. **DEPS_SUMMARY.md** — Dependencies, scripts, security notes
3. **FIX_BACKLOG.md** — All 14 issues (severity-sorted, file paths)
4. **FIX_PLAN_v1.md** — State enum + guard implementation details

---

## Owner Approvals Needed

- [ ] Confirm scope (read-only, no changes this phase)
- [ ] Approve state enum pattern
- [ ] Approve guard-rail guards (play only if READY)
- [ ] Approve logging approach (dev-mode only)
- [ ] Approve acceptance test checklist
- [ ] Approve before proceeding to FIX_PLAN_v1

---

## Next Steps (If Approved)

1. Produce remaining artifacts (REPO_MAP, DEPS_SUMMARY, FIX_BACKLOG)
2. Wait for owner approval of FIX_PLAN_v1
3. Only then: Create branch, patch, test, produce PATCH_RECEIPT.json
4. Owner reviews patch receipt before merge

---

**Status:** 🟡 Awaiting Approval (Phase 1 Scope)  
**Owner:** John Steele  
**Horizon:** Read-only mode until green light
