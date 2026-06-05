# Non-faststarted MP4 Implementation

## Problem

MP4 files with the `moov` atom at the end (non-faststarted) cannot play immediately via MSE because mp4box.js needs the `moov` atom to initialize tracks before it can process media data. The original implementation failed to find the moov atom in the tail data, causing a native playback fallback that triggered massive download cascades.

## Root Cause

The `extractMoovFromBuffer` function used **forward box scanning** — reading `[4-byte size][4-byte type]` headers and jumping by `boxSize` to the next box. This approach failed because:

- The 5MB tail fetch starts **mid-mdat** (inside the huge media data box)
- The forward scanner interprets random mdat payload bytes as a "box header"
- It gets a huge "size" value that jumps past the entire buffer
- The moov atom at the end is completely missed

## Solution: Backward Scan

The `extractMoovFromBuffer` function now uses **backward scanning** from the end of the buffer:

1. Search backward for `moov` type bytes (`0x6D 0x6F 0x6F 0x76`)
2. When found, validate the preceding 4-byte size field
3. Verify the moov's internal structure (first child box type must be `mvhd`, `trak`, etc.)
4. Calculate the absolute file offset and return the moov data

This approach is reliable because:
- The moov atom is always at or near the end of moov-at-end files
- We don't need box-aligned starting position
- False positives (random `moov` bytes in mdat) are filtered out by child box validation

### Validation checks

- `actualSize >= 8` (minimum valid box)
- `actualSize < 100MB` (moov atoms are typically <50MB)
- `moovStart + actualSize <= fileLength + 1` (moov should fit in file)
- First child box type must be a known moov child (`mvhd`, `trak`, `udta`, `meta`, `mvex`, `moof`)

## Progressive Tail Fetch

The `fetchMoovFromTail` function now progressively increases the tail fetch size:

- First try: 5MB tail
- Second try: 10MB tail (if moov not found in 5MB)
- Third try: 20MB tail (for very large moov atoms)
- If still not found: fall back to native playback

This handles cases where the moov atom is larger than 5MB (long videos with many tracks).

## Partial Moov Handling

If the moov atom extends beyond the fetched tail data, the code:
1. Reads the declared moov size from the box header
2. Fetches the complete moov via a separate range request
3. Appends the complete moov to mp4box.js

## Thumbnail/Preview Fix

The `useThumbnailExtractor` had two issues:

1. **Main video capture required `mseReady=true`** — blocked thumbnail capture during native playback fallback
2. **Hidden video uses `streamUrl` directly** — for non-faststarted MP4s, native playback fails to load metadata (moov-at-end)

### Fixes applied

1. **Removed `mseReady` requirement** from main video capture — thumbnails now captured during both MSE and native playback
2. **Hidden video limitation acknowledged** — for non-faststarted MP4s, the hidden video won't work (native playback can't load moov-at-end metadata). Hover thumbnails for unbuffered positions require a different approach (future: backend ffmpeg thumbnail generation)

## Key Files Modified

- `app/src/hooks/useMSEPlayer.ts`:
  - `extractMoovFromBuffer`: Replaced forward box scan with backward search + validation
  - `fetchMoovFromTail`: Progressive tail fetch (5MB → 10MB → 20MB) + complete moov fetch
  - Removed old `fetchMoovFromTail` duplicate code

- `app/src/hooks/useThumbnailExtractor.ts`:
  - Removed `mseReady` requirement from main video capture effect
  - Parameter `mseReady` → `_mseReady` (unused but kept for API compatibility)

## Testing Checklist

- [ ] Faststarted MP4 (moov-at-front): still works correctly via forward scan
- [ ] Non-faststarted MP4 (moov-at-end): backward scan finds moov in 5MB tail
- [ ] Large moov (>5MB): progressive fetch finds moov in 10MB/20MB tail
- [ ] Native playback: thumbnails captured from main video
- [ ] MSE playback: thumbnails captured from main video + hover via hidden video
- [ ] No download cascade after moov-from-tail success
