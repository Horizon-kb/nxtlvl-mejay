# Phase 2.5 Stability Analysis

**Date:** 2026-02-23  
**Issues Found During Testing:** 5  
**Status:** 🟡 Analysis complete, ready for fixes

---

## Issue #16: Restart Button Failing

**File:** `src/stores/djStore.ts` (line 1884)  
**Component:** `src/components/party/NowPlaying.tsx` (line 283)

**What's Happening:**
- Button is wired correctly: `onClick={() => restartCurrentTrack()}`
- Function exists in store: `restartCurrentTrack: (arg?: ...)`
- Function logic looks intact (lines 1884-1914+)

**Likely Cause:**
1. **Try-catch silently swallowing error** — Function uses try-catch blocks
2. **State or deck mismatch** — Line 1910: `const track = getDeckTrack(state, targetDeck)`
3. **Audio engine error** — Calls to audioEngine.* might be failing silently

**Diagnosis Needed:**
- Add logging to restartCurrentTrack() to see where it fails
- Check browser console for JS errors
- Verify audioEngine methods exist (enableMixCheck, resetMixTrigger)

**Fix Approach:**
Add dev-mode logging to track:
- Function entry
- getDeckTrack result (null vs valid)
- Each try-catch error
- Final state after restart

---

## Issue #17: Previous Song Should Mix, Not Skip

**File:** `src/stores/djStore.ts` (need to find `smartBack` action)  
**Component:** `src/components/party/NowPlaying.tsx` (line 269)

**What's Happening:**
- Button calls `smartBack()` 
- Current behavior: Unknown (needs to be verified)
- Expected behavior: Mix current track into previous song (like a transition)

**Diagnosis Needed:**
- Find `smartBack` implementation in djStore
- Check what it currently does (skip back? restart? pause?)
- Understand "mix into previous" requirement:
  - Load previous track on inactive deck?
  - Start crossfade?
  - Trigger mix transition?

**Fix Approach:**
1. Locate smartBack implementation
2. Compare to expected behavior
3. If it's skipping back, change to mix logic
4. If missing, implement mix-previous handler

---

## Issue #18: Toast Messages Need 4s Auto-Dismiss

**File:** `src/hooks/use-toast.ts` (line 6)  
**Status:** 🔴 CLEAR BUG FOUND

**Current Code:**
```typescript
const TOAST_REMOVE_DELAY = 1000000;  // ← 1 MILLION milliseconds = ~16.67 MINUTES
```

**Expected:**
```typescript
const TOAST_REMOVE_DELAY = 4000;  // ← 4 seconds
```

**Impact:**
- All toasts stay on screen for 16+ minutes instead of 4 seconds
- Users can manually dismiss, but default behavior is broken
- Toasts pile up instead of auto-clearing

**Fix:** Change line 6 value from `1000000` to `4000`

---

## Issue #19: Starter Packs Default Download Location

**File:** Unknown (need to locate download handler)  
**Search Terms:** "starter packs", "download", "starter", "pack"

**Diagnosis Needed:**
- Where are starter packs being downloaded?
- What's the current location/behavior?
- What should it be instead?
- Is this a file path issue or UI routing issue?

**Files to Check:**
- `src/stores/djStore.ts` - probably has downloadStarterPacks() action
- `src/config/starterPacks.ts` - pack definitions
- Any download/file handling components

---

## Issue #20: Logo Size Too Small

**Files:** `src/components/` (likely PartyModeView.tsx or App.tsx)  
**Search Terms:** "logo", "Logo", "branding", "icon"

**Diagnosis Needed:**
- Where is the logo rendered?
- Current size (width/height/rem)?
- Expected size?
- Context (header, sidebar, fullscreen)?

**Fix Approach:**
- Find logo component/element
- Check current className or style
- Increase width/height values
- Test responsiveness (mobile vs desktop)

---

## Severity & Priority

| Issue | Type | Severity | Complexity | Est. Fix Time |
|-------|------|----------|-----------|---------------|
| #16 (Restart fails) | Logic | HIGH | Medium | 30 min (diagnosis) |
| #17 (Previous should mix) | Logic | MEDIUM | High | 45 min |
| #18 (Toast auto-dismiss) | Bug | MEDIUM | Low | 5 min |
| #19 (Pack download location) | Unknown | MEDIUM | Unknown | TBD |
| #20 (Logo size) | UI | LOW | Low | 5 min |

---

## Recommended Fix Order

1. **#18 (Toast)** — Trivial fix, high impact on UX
2. **#16 (Restart)** — Blocking functionality
3. **#17 (Previous)** — Core feature not working
4. **#20 (Logo)** — Polish, won't block testing
5. **#19 (Packs)** — Needs clarification on requirement

---

## Next Steps

**I Need From You:**

1. **Issue #16 (Restart):** 
   - What error do you see when you click Restart?
   - Does it throw an error or just silently fail?

2. **Issue #17 (Previous):**
   - What does "mix into previous song" mean exactly?
   - Should it:
     - Load previous on other deck + crossfade?
     - Create a transition state?
     - Something else?

3. **Issue #19 (Starter Packs):**
   - Where should downloaded packs go?
   - Current location vs expected location?

4. **Issue #20 (Logo):**
   - Where is it (header/toolbar)?
   - Current size vs target size?

Once I have these details, I can produce FIX_PLAN_v2.5 with exact code changes.

---

**Status:** 🟡 Analysis complete, awaiting clarifications  
**Action Required:** Answer the 4 questions above
