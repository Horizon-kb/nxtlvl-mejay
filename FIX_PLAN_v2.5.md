# MeJay Fix Plan v2.5 — Stability Pass

**Date:** 2026-02-23  
**Owner Approval:** ✅ John Steele (23:42 EST)  
**Status:** Ready for Implementation  
**Scope:** 4 critical fixes (restart, previous-mix, pack download, logo size)

---

## Priority 1: Fix #16 — Restart Button (Song Stops)

**File:** `src/stores/djStore.ts`  
**Function:** `restartCurrentTrack` (line 1884)  
**Issue:** Song stops completely; playback doesn't resume

**Current Behavior:** 
```
User clicks Restart → Song stops → Nothing happens
```

**Expected Behavior:**
```
User clicks Restart → Song seeks to 0 → Playback resumes
```

**Root Cause:**
Need to diagnose in code. Likely:
1. `audioEngine.play()` call missing or failing
2. State not updating correctly
3. Error being silently caught

**Fix Strategy:**
1. Add dev logging to restartCurrentTrack() entry
2. Log getDeckTrack() result
3. Log each step: seek, play, state update
4. Check if audioEngine.play() is being called
5. If missing, add it

**Code Location to Check:**
```typescript
restartCurrentTrack: (arg?: ...) => {
  // ... line 1884-1930+
  // Look for audioEngine.play() call
  // If not there, add after seek/load
}
```

**Acceptance Test:**
```
1. Load track
2. Play (track should play)
3. Click Restart button
4. Expected: Track restarts from 0, plays
5. Actual: (currently stops)
```

---

## Priority 2: Fix #17 — Previous Button (Should Mix, Not Skip)

**File:** `src/stores/djStore.ts`  
**Function:** Need to find `smartBack` (called from NowPlaying line 269)

**Issue:** Previous button should transition current song into previous song (mix), not skip back

**Current Behavior:**
```
Click Previous → ??? (need to verify what it does now)
```

**Expected Behavior:**
```
Click Previous → 
  1. Load previous track on inactive deck (with crossfade start offset)
  2. Trigger crossfade transition from current to previous
  3. Play previous track after fade completes
```

**Comparison to Skip (which you click to go forward):**
- Skip: Loads next track on inactive deck, starts crossfade
- Previous: Should do same but with previous track

**Code Location:**
Find `smartBack:` in djStore.ts (probably near `skip:` action)

**Fix Strategy:**
1. Locate smartBack implementation
2. If it currently skips back: Change to load-previous-on-other-deck logic
3. If it's doing something else: Clarify and adjust
4. Reuse skip/transition logic but for previous track

**Acceptance Test:**
```
1. Load Track A, play
2. Queue: [A, B, C]
3. Auto-advance to B
4. Click Previous button
5. Expected: 
   - Deck B (was playing) should fade out
   - Deck A (previous) should load and fade in
   - Result: A plays after smooth crossfade
```

---

## Priority 3: Fix #18 — Toast Auto-Dismiss (4 seconds)

**File:** `src/hooks/use-toast.ts`  
**Line:** 6  
**Issue:** ✅ CLEAR BUG — Toasts stay for 16+ minutes instead of 4 seconds

**Current Code:**
```typescript
const TOAST_REMOVE_DELAY = 1000000;  // 1 million ms = 16.67 min
```

**Fix:**
```typescript
const TOAST_REMOVE_DELAY = 4000;  // 4 seconds
```

**Impact:** All toast messages will now auto-dismiss after 4 seconds

**Acceptance Test:**
```
1. Trigger any action that shows a toast (e.g., skip song)
2. Watch toast message
3. Expected: Disappears after 4 seconds
4. (Currently: Stays until manually closed or 16+ min passes)
```

---

## Priority 4: Fix #19 — Starter Packs Download Location

**File:** `src/stores/djStore.ts`  
**Function:** `downloadStarterPacks` (need to find line number)  
**Issue:** No user control over download location; no notification of where file went

**Expected Behavior:**
```
1. User clicks "Download Starter Pack"
2. File downloads to ~/Downloads folder
3. Toast notification shows: "Starter pack downloaded to Downloads folder"
4. User can access file immediately
```

**Fix Strategy:**
1. Find downloadStarterPacks() action
2. Detect Downloads folder path (platform-aware: Windows/Mac/Linux)
3. Add file save dialog OR default to Downloads
4. Show toast notification with file path
5. Optionally: "Open in folder" button in toast

**Code Pattern:**
```typescript
downloadStarterPacks: async (packIds: string[]) => {
  // ... existing download logic ...
  
  // NEW: Get Downloads folder path
  const downloadsPath = getDownloadsFolder();
  
  // NEW: Save file to Downloads
  const filePath = await saveToDownloads(packIds);
  
  // NEW: Notify user
  toast({
    title: 'Download complete',
    description: `Saved to ${downloadsPath}`,
    action: <Button onClick={() => openFolder(downloadsPath)}>Open folder</Button>
  });
}
```

**Files to Check:**
- Where does downloadStarterPacks currently save?
- Is there a file API available?
- Need to find the actual download handler

**Acceptance Test:**
```
1. Click download starter pack
2. Expected: File saves to ~/Downloads
3. Expected: Toast shows "Starter pack downloaded to [path]"
4. User can navigate to Downloads and find file
```

---

## Priority 5: Fix #20 — Logo Size (2x Larger)

**File:** Logo component location TBD  
**Issue:** Logo on all tabs/pages is too small; should be 2x current size

**Search Locations:**
- `src/components/` - check for logo/branding
- `src/app/` - check app layout
- Header/nav components
- Look for className like `w-[size]` or style with `width:`

**Fix Strategy:**
1. Find logo element in all locations where it appears
2. Identify current size (e.g., `w-12` = 48px)
3. Double it (e.g., `w-24` = 96px)
4. Check responsive behavior (mobile vs desktop)
5. Ensure it fits without breaking layout

**Code Pattern (if using Tailwind):**
```typescript
// BEFORE
<img src={logo} className="w-12 h-12" />

// AFTER
<img src={logo} className="w-24 h-24" />
```

**Acceptance Test:**
```
1. Load app on all pages
2. Check logo on: header, tabs, navigation
3. Expected: Logo is noticeably larger (2x current)
4. Expected: Layout still looks good, no overflow
5. Expected: Mobile view still responsive
```

---

## Implementation Order

1. **#18 (Toast)** — Trivial 1-line fix, test immediately
2. **#16 (Restart)** — Add logging, diagnose, fix playback resume
3. **#17 (Previous)** — Refactor smartBack to use mix logic
4. **#19 (Download)** — Find handler, add path + notification
5. **#20 (Logo)** — Find all logo elements, 2x sizes

---

## Files to Modify

```
src/hooks/use-toast.ts          (1 line change: TOAST_REMOVE_DELAY)
src/stores/djStore.ts           (restartCurrentTrack, smartBack, downloadStarterPacks)
src/components/party/NowPlaying.tsx  (may need logging for #16 diagnosis)
Logo component (location TBD)    (size increase for #20)
```

---

## Testing Checklist (After Fixes Applied)

- [ ] Click Restart → Track plays from beginning (not stopped)
- [ ] Click Previous → Current fades out, previous fades in (mix transition)
- [ ] Trigger any action showing toast → Message disappears after 4 seconds
- [ ] Download starter pack → Notification shows file saved to Downloads
- [ ] All pages → Logo is noticeably 2x larger than before
- [ ] Mobile view → Logo still fits, layout responsive

---

## Rollback Plan

```bash
git reset --hard HEAD~[n]  # Where n = number of commits to revert
```

All changes on branch `mejay-phase1-fixes`, so safe to rollback to any prior commit.

---

**Status:** 🟡 Ready for Code Implementation  
**Owner:** John Steele  
**Next:** Await approval to proceed with fixes
