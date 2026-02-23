# MeJay Bug Hunt Checklist
**Date:** 2026-02-23  
**Tester:** Horizon  
**Priority:** Find and document existing bugs (not features)

---

## Critical Areas to Test

### 1. Advanced Volume Controls ⚠️ REPORTED ISSUE
- [ ] Test auto-volume matching (enable/disable)
- [ ] Test limiter presets (soft/medium/hard)
- [ ] Volume fading behavior on track change
- [ ] Check for clipping/distortion artifacts
- [ ] Verify gain staging doesn't exceed 0dB

**Expected:** Smooth, artifact-free volume changes
**Report:** Any audible clicks, pops, or level jumps

### 2. BPM Detection & Matching ✅ WORKS WELL (minor improvements)
- [ ] Detect BPM on various audio formats/bitrates
- [ ] Verify "confidence score" accuracy
- [ ] Test auto-match on tracks with varying BPMs
- [ ] Check tempo stretch limits (min/max)
- [ ] Identify edge cases (very fast/slow tracks)

**Expected:** Smooth tempo matching, no audible artifacts
**Report:** Any sync issues or stretching artifacts

### 3. Advanced BPM Modes ⚠️ REPORTED SHAKINESS
- [ ] Test energy mode (how does it calculate energy?)
- [ ] Test locked BPM mode (should hold one BPM)
- [ ] Test tempo matching with extreme BPM differences
- [ ] Monitor for phase issues during tempo changes

**Expected:** Stable, predictable behavior
**Report:** Warbling, phasing, or instability

### 4. Song Transitions ⚠️ REPORTED AMBIGUITY
- [ ] Test crossfade on track change
- [ ] Check for gaps between tracks (silence)
- [ ] Verify overlapping audio (if using crossfade)
- [ ] Test auto-advance in playlist mode
- [ ] Monitor queue for incorrect order/skips

**Expected:** Seamless transitions, no gaps or glitches
**Report:** Clicks, pops, silence, or dropouts

### 5. Presets ✅ WORKING PERFECTLY
- [ ] Verify all presets load/apply correctly
- [ ] Check preset persistence (save/load)
- [ ] Test preset switching during playback

**Expected:** Clean preset switching
**Report:** Any artifacts

---

## Test Scenarios

### Scenario A: Basic Playback
1. Import 3 audio files (different tempos)
2. Create playlist
3. Play through all 3 tracks
4. Monitor for issues during transitions

### Scenario B: Auto-Match BPM
1. Create playlist with varied BPM tracks (e.g., 90, 140, 100)
2. Enable auto-match
3. Play through, listen for sync issues
4. Check tempo stretch quality

### Scenario C: Volume Control
1. Enable auto-volume
2. Play tracks of different loudness
3. Listen for clicks/pops
4. Test limiter (switch presets)
5. Verify no clipping

### Scenario D: Advanced BPM Modes
1. Test energy mode (does energy detection work?)
2. Test locked BPM (should maintain one BPM)
3. Monitor for phase/warble artifacts

### Scenario E: Party Mode
1. Create playlist
2. Start Party Mode
3. Let auto-advance run through 5+ tracks
4. Monitor queue accuracy
5. Test shuffle, loop

---

## Known Issues (Per John)

| Issue | Area | Severity | Notes |
|-------|------|----------|-------|
| Shakiness | Advanced BPM modes | HIGH | Affects tempo stability |
| Not smooth | BPM detection | MEDIUM | Works but could improve UX |
| Ambiguity/glitches | Song transitions | HIGH | Can't pin down exact cause |
| Issues | Volume controls | MEDIUM | Advanced controls problematic |

---

## How to Report

Format:
```
**Title:** [Brief description]
**Area:** [Volume/BPM/Transitions/etc]
**Severity:** BLOCKER | HIGH | MEDIUM | LOW
**Steps to Reproduce:**
1. ...
2. ...
**Expected:** ...
**Actual:** ...
**Notes:** ...
```

---

## Next Steps
1. Run npm install
2. Run `npm run test` to validate test suite
3. Boot `npm run dev` and manually test scenarios
4. Read audio engine code (src/engines/)
5. Document findings in BUG_REPORT.md

