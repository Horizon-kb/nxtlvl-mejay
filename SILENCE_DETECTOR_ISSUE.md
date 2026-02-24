# MeJay Silence Detector Issue

**Date:** 2026-02-23  
**Discovered:** During Phase 1 audit  
**Status:** 🔴 NOT WORKING (wired but not connected)  
**Severity:** MEDIUM (affects mix timing on tracks with trailing silence)

---

## Summary

**What's Implemented:**
- ✅ Silence detection function (`detectTrueEndTime()` in `src/lib/trueEndTime.ts`)
- ✅ Called during track import (3 locations in djStore.ts: lines 691, 1169, 1593)
- ✅ Stored to Track object (`track.trueEndTime`)
- ✅ Audio engine has `setTrueEndTime()` method (line 213, audioEngine.ts)

**What's Broken:**
- ❌ When a track is loaded onto a deck for playback, `trueEndTime` is never passed to the audio engine
- ❌ Audio engine never calls `setTrueEndTime()` during track load
- ❌ Mix trigger uses full `duration` instead of trimmed `trueEndTime`
- **Result:** Silence detector runs but has zero effect; crossfades still hit trailing silence

---

## Root Cause

**File:** `src/stores/djStore.ts`  
**Function:** `loadTrackToDeck()`

**What happens:**
```typescript
// Line ~1700 (approximate)
await audioEngine.loadTrack(deck, blob, bpm, gainDb);
// ❌ MISSING: audioEngine.setTrueEndTime(deck, track.trueEndTime);
```

After `loadTrack()` succeeds, the code never retrieves `track.trueEndTime` and passes it to the engine.

**Where it SHOULD be wired:**
```typescript
// In loadTrackToDeck(), after audioEngine.loadTrack() succeeds:
const track = state.tracks.find(t => t.id === trackId);
if (track && track.trueEndTime) {
  audioEngine.setTrueEndTime(deck, track.trueEndTime);
}
```

---

## Detection Path (How It's Currently Used)

**During Import:**
1. User imports audio file
2. djStore calls `detectTrueEndTime(audioBuffer, {...})`
3. Returns clean end time (trims trailing silence)
4. Saves to `track.trueEndTime` in IndexedDB
5. Calls `audioEngine.setTrueEndTime()` if track is currently loaded ✅ (line 1644-1648)

**During Playback Load:**
1. User clicks track to load on deck
2. `loadTrackToDeck()` calls `audioEngine.loadTrack(deck, blob, ...)`
3. Track loads but `trueEndTime` is never set on the deck
4. Audio engine uses full `duration` for mix trigger calculations
5. **Result:** Crossfade triggers at `duration` not `trueEndTime` ❌

---

## Impact

**Affected Feature:** Mix trigger timing in Party Mode

| Scenario | Expected | Actual |
|----------|----------|--------|
| Track with 2s trailing silence, 3m58s audio | Mix triggers at 3m58s | Mix triggers at 4m00s (includes silence) |
| Crossfade starts early | User hears 2s silence before next track | User hears 2s silence during crossfade |
| Consequence | Smooth transition | Awkward silence gap |

---

## Fix

**Severity:** MEDIUM (affects UX, not app stability)  
**Priority:** After Phase 1 core fixes (after state enum + guards)  
**File to Change:** `src/stores/djStore.ts`  
**Function:** `loadTrackToDeck()`  
**Lines:** ~1700-1750 (approximate, TBD on exact location)

**Pseudocode:**
```typescript
async loadTrackToDeck(trackId: string, deck: DeckId, offsetSeconds?: number): Promise<void> {
  // ... existing code to find track + load blob ...
  
  const track = state.tracks.find(t => t.id === trackId);
  const blob = track?.fileBlob;
  
  // Load audio
  const duration = await audioEngine.loadTrack(deck, blob, track?.bpm, track?.gainDb);
  
  // NEW: Pass trueEndTime if available
  if (track?.trueEndTime) {
    audioEngine.setTrueEndTime(deck, track.trueEndTime);
  }
  
  // ... rest of function ...
}
```

**Lines to Add:** ~3 lines  
**Complexity:** Trivial (single function call)

---

## Acceptance Test

```
1. Import an audio file with trailing silence (e.g., 5 seconds silence at end)
2. Wait for import analysis to complete (should show trueEndTime in console or dev tools)
3. Load track onto Deck A
4. Enable Party Mode, set Deck B to next track
5. Let Deck A play to near end
6. Expected: Crossfade triggers at real end (before silence)
7. Actual (now): Crossfade triggers at full duration (includes silence)
8. After fix: Crossfade should trigger at real end
```

---

## Related Code References

**Silence Detection (Working):**
- `src/lib/trueEndTime.ts` — Detection logic (lines 20-70)
- `src/stores/djStore.ts` — Called during import (lines 691, 1169, 1593)

**Audio Engine (Prepared):**
- `audioEngine.setTrueEndTime()` — Method exists, validates input (line 213)
- `checkMixTrigger()` — Already uses `trueEndTime` if set (line 607-609)

**Missing Link:**
- `loadTrackToDeck()` — Doesn't pass trueEndTime to engine (exact line TBD)

---

## Why It Wasn't Caught

The silence detector was built as a **separate system** from the playback loader:
- Import analysis: ✅ Calculates trueEndTime, saves to track
- Playback: ❌ Loads track from blob, forgets to use stored trueEndTime
- Result: Two parallel systems that don't communicate

---

## Add to FIX_BACKLOG

**Issue #15: Silence Detector Not Wired to Playback**  
**Severity:** MEDIUM  
**File:** `src/stores/djStore.ts` (loadTrackToDeck)  
**Phase:** 2 (after Phase 1 core fixes)  
**Fix:** Call `audioEngine.setTrueEndTime(deck, track.trueEndTime)` after loading track  
**Lines:** ~3 LOC  
**Acceptance:** Track with silence imports cleanly; crossfade triggers at real end, not full duration

---

**Status:** 🟡 Ready for Phase 2  
**Owner:** John Steele  
**Priority:** After Phase 1 state enum + guards deployed and tested
