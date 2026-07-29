# UI/UX research: audio-track menu (clone of the subtitle menu)

Audited directly from source 2026-07-29. All quotes verbatim from
`app/src/components/dashboard/FastStreamPlayer.tsx` (the ONLY player UI — MediaPlayer.tsx
has no subtitle UI; grep 'subtitle' there = 0 hits in controls).

## 1. Subtitle menu anatomy (the template to clone)

Controls are a **chip registry**: `chipButton(id)` switch at FastStreamPlayer.tsx:1734 —
each control is a case returning `{label, el}`; a persisted layout places chips into
left/right/tray zones. **An audio menu = one new case in this registry** (e.g. `'audio'`),
automatically placeable like every other chip.

Subtitle chip = `case 'captions'` :1744-1762:
- Wrapper: `<div className="relative">`
- Trigger button :1746:
  `className={`p-1.5 hover:bg-white/10 rounded transition-colors ${subs.activeTracks.length ? 'text-nobuf-primary' : 'text-white'}`}`
  (icon-active state = `text-nobuf-primary`; idle = `text-white`; svg `w-5 h-5`)
- Popup :1749-1761, **conditional rendering** (`{subMenu && (...)}` — no max-height
  transitions, no native <select>):
  `className="absolute bottom-full right-0 mb-2 bg-black/95 border border-white/10 rounded-lg overflow-hidden min-w-[180px] max-h-72 overflow-y-auto z-50 shadow-2xl py-1"`
- Item ACTIVE: `text-nobuf-primary bg-nobuf-primary/10 font-semibold` (:1753)
- Item INACTIVE: `text-white` (+ shared `block w-full text-left px-3 py-1.5 text-sm hover:bg-white/10 truncate`)
- "Off" entry first (:1751), active when nothing selected: `text-nobuf-primary font-semibold`
- Label rule :1754: `{t.label || t.language || `Track ${i + 1}`}` (+ suffix annotation
  like `(ASS)`) → audio equivalent: `{lang name || 'Track N'}` + ` — AAC 5.1` style subtext.
- Menu state: `subMenu` boolean via `setSubMenu` (:1746, toggled with e.stopPropagation();
  outside click closes it via the player's global click handling — same for `menu` (speed)).
- Popup clicks guarded: `onClick={e => e.stopPropagation()}` (:1750).

## 2. Controls bar & insertion point

Chip ids in the registry (order of cases): skipBack, skipFwd, **captions** (:1744),
loop (:1763), pip (:1767), speed (:1771), ... Audio chip: add `case 'audio'` directly
after `case 'captions'` and register the id in the default layout adjacent to captions.
NOTE: layout is persisted — check the layout default array + any stored-layout migration
so existing users see the new chip (find where the chip layout default list lives during
impl; a persisted old layout must not hide the new chip forever).

## 3. Keyboard shortcut precedent

'c' toggles subtitles (:1706-1713) — an audio-cycle shortcut is OPTIONAL phase-2; not
required for parity.

## 4. Persistence patterns (localStorage inventory — full app grep)

- `sidebar-collapsed` (Dashboard.tsx:95/103)
- `nobuf-theme`, `nobuf-custom-themes`, `nobuf-active-theme` (ThemeContext.tsx:29-122)
- **No per-file preference exists anywhere** (no volume/position/subtitle persistence).
Recommendation: per-file audio choice key `nobuf-audio-track` holding a small LRU JSON map
`{ "<folderId>:<messageId>": <audioStreamIdx>, ... }` (cap ~200 entries) — follows the
`nobuf-*` naming, avoids unbounded key sprawl. Read at player init; write on switch.

## 5. Rebuild feedback

The audio switch on remux/MKV/MP4 tiers rebuilds like a seek. Reuse the EXISTING seek
feedback path (buffering spinner tied to the seek/refill chain), NOT the cold-start
overlay (`isColdStartBuffering`/`coldStartPhase` — that's for initial open; hijacking it
for switches would flash "initializing player" UI). Verify in impl: whatever indicator a
normal unbuffered seek shows is what a switch shows. A short toast (`toast.success` is
already imported in FastStreamPlayer :1488 usage) on failure-revert: "Audio switch failed —
reverted" matches the sidecar-subs error precedent (:1490 `toast.error`).

## 6. Hard product rules (recorded)

- NEVER native `<select>` — popup buttons exactly like :1749-1761.
- Menu chip hidden entirely when ≤1 audio track (`{audioTracks.length > 1 && ...}` around
  the chip el, or return null from the case) — no dead UI.
- Switching must NEVER unpause a paused player ("paused means paused").
- Surgical: do not touch/restyle existing chips, layout, or the popup pattern.
- Theme via `--color-nobuf-*` classes (`text-nobuf-primary`, `bg-nobuf-primary/10`) — no
  hardcoded colors.
