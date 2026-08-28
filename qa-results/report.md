# QA Report — Split-Upload Phase E (Resume/Discard + Startup Notice)

Date: 2026-08-26 · Branch: `feature/large-video-split-upload` · Method: live e2e over CDP (`--remote-debugging-port=9333`), fake-cap env `NOBUF_FAKE_UPLOAD_CAP_BYTES`, synthetic 159 MB / 300 s fixture (CBR x264), driven via the app's own `__NOBUF_SPLIT_DEV__` seam.

⚠️ Disclosure: the fake-cap knob fakes the LIMIT only — uploads are real. ~450 MB of test parts were uploaded to Saved Messages during this run (3 completed jobs, message ids 256–261). Trivial against the 250 GB daily budget; parts remain listed in Saved Messages.

## Results

| # | Test | Result | Evidence |
|---|---|---|---|
| T1 | Oversize pick → split modal (filmstrip, part names, byte estimates) | ✅ PASS | Modal: "qa_phaseE_big.mp4 · 159 MB · 05:00", 3 parts w/ snapped boundaries, CTA "Split & Upload (3 parts)" |
| T2a | Start job → cancel mid-run via row × button | ✅ PASS | Row showed "uploading part 2/3 (33%)" at click; DB flipped to `interrupted`/"Cancelled by user"; temps cleaned |
| T2b | Interrupted row shows Resume + Delete immediately (no restart) | ✅ PASS after fix F1 | "paused — will resume from last part | Resume | Delete" within ~1 s |
| T3 | Delete → themed danger dialog; "Keep Job" preserves row | ✅ PASS | ConfirmContext dialog rendered with exact copy; cancel path kept job |
| T4 | Confirmed Delete removes DB row + panel row + success toast | ✅ PASS | `d095a869…` vanished from SQLite; toast fired; second row remained |
| T5a | Interrupted job survives app restart → row hydrated | ✅ PASS | Row present post-reboot from `cmd_list_split_jobs` hydration |
| T5b | Startup notice fires on cold boot with interrupted jobs | ✅ PASS after fix F3 | Console stream proof: `[SPLIT] startup resume notice: 1 interrupted job(s)` on every boot |
| T5c | Resume after restart picks up at first unfinished part | ✅ PASS | Clicked Resume → row flipped to "uploading part 2/3", toast 'Resuming "qa_phaseE_big"' |
| T6 | Kill -9 mid-upload ("crash") → normalize on next boot | ✅ PASS | Watcher killed app.exe while status=`running`; next boot: `interrupted`/"App closed mid-job" |

## Defects found & fixed during QA (commit f5b7f97)

| ID | Severity | Defect | Fix |
|---|---|---|---|
| F1 | **High** | Terminal transitions never emitted `split-progress`; panel row froze at "uploading…" until restart | `update_status()` now emits with real done/total counts on interrupted/done/failed/cancelled/source_missing |
| F2 | Medium | Dialog promised remote deletion that `cmd_discard_split_job` doesn't do (job record + temps only) | Copy corrected to reality; remote part-deletion = follow-up decision |
| F3 | Low (testability) | Sonner mounts its toaster node lazily → "null DOM" falsely suggested the notice never fired | `[SPLIT] startup resume notice: N` console line beside every fire |

Pre-existing finding carried from review: `window.confirm` → themed `useConfirm()` (fixed in 26e0009).

## Not covered (honest gaps)

- Resume across a real source-file change (`source_changed` refusal) — needs a mutated-source scenario
- Multi-job queued→promotion under the single-pipeline rule during these flows
- Real Telegram-side deletion of orphaned parts after Discard — NOT IMPLEMENTED (product decision pending)

## Verdict

**PASS.** Phase E is functionally complete and now runtime-proven. Two real defects found and fixed by testing it live — exactly why this pass was worth running.

## Environment notes for future QA

- Fixture sizing is constrained by TWO backend guards: cap must exceed 64 MiB margin AND parts must average ≥60 s ⇒ practical minimum ≈ file >128 MiB. Use `-x264-params nal-hrd=cbr` for deterministic size; VBR undershoots badly on synthetic content.
- The split modal's flow-state persists across a failed `prepare()` ("started ✓" screen wins) — close it via Done before re-preparing.
- `tauri dev`'s watcher auto-rebuilds on Rust edits and restarts the app — use it instead of manual relaunch cycles.
- Driving tip: chain start+cancel+assert into ONE page-side JS evaluation; per-action CDP round-trips (~1–6 s) overshoot the whole upload.
