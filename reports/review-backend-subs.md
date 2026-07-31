# Backend Review — Embedded Subtitle Extraction (server.rs +844)

**Reviewed:** 3 endpoints (`/subtitles/{f}/{m}/list|track/{idx}|font/{att}`), pure helpers, memo field, 8 unit tests.
**Process note:** two independent reviewer passes were destroyed mid-verdict by a provider infra error (brotli decode, both rounds); their complete investigation trails survived and every claim below was re-verified against live source line-by-line before writing.

**Verdict:** **Approve** (2 findings fixed post-review, rest advisory)

## Tests-first
8 new tests cover: probe JSON classification (text/bitmap/unsupported, tags, dispositions, mov_text `tags.name` fallback), malformed JSON, kind table, font detection (mimetype+extension), cache filename keying (per-track, per-format), extraction arg shape (absolute `-map 0:N`, no `?`, `-sub_charenc` before `-i`), font-dump arg shape (`-dump_attachment` before `-i`, `-t 0.01 -f null -`), serde round-trip. These test behavior (arg contracts, not implementation privates). **Gap (accepted):** endpoint handlers themselves untested (HTTP-level: 429/204/504 paths) — consistent with house precedent (audio_tracks endpoints also test helpers only).

## Findings (severity-ordered)

- **Checked OK — inflight guard atomicity** (server.rs:6065-6080): `HashSet::insert` under a single `StdMutex::lock` is an atomic check-and-insert; `SubsInflightGuard` Drop removes. Disk-cache check precedes guard acquisition, so two concurrent cold requests → one extracts, one gets 429 + Retry-After (client retries once). No double-ffmpeg path.
- **Checked OK — .tmp collisions:** tmp name = `{folder}_{msg}_s{idx}.{ext}.tmp`, per-track unique; per-message serialization prevents same-message races; cross-message names differ by msg id.
- **Checked OK — folder_id traversal:** `resolve_media_from_path` (server.rs:485-492) admits only `me|home|null` or a valid `i64` — 400 otherwise, and every subtitle handler resolves media BEFORE building any cache filename. `sub_cache_filename` can never receive path separators.
- **Checked OK — memo semantics for subtitle-free files:** a real video always has ≥1 stream, so `has_streams` passes, `parse_subtitle_probe_json` yields empty `tracks[]`, and that empty inventory IS memoized → no per-menu-open re-probe. The `has_streams` 502 (no memo) fires only on exit-0-with-unusable-output, which is the intended fail-open.
- **Checked OK — eviction:** subs cache lives under `{cache_dir}/remux/subs`; `cache_dir` is wiped at every startup (lib.rs:304 `remove_dir_all`) and `%TEMP%/nobuf_remux` too (lib.rs:315). Bounded per-session, same lifecycle as the remux cache. Not unbounded growth.
- **Checked OK — command injection:** all ffmpeg/ffprobe invocations use args arrays (no shell); the only interpolated values are an i32 stream index and endpoint-controlled paths.
- Consider: **120s extraction cap** can genuinely expire on multi-GB uncached MKVs over rate-limited Telegram (subs research P6 measured ~774MB pulled for one tail-heavy track). Client surfaces a toast on 504; the partial-cache serve-don't-cache path softens repeats. Acceptable for v1; revisit if users hit it.
- Consider: `subs_input_source` duplicates the remux input-resolution idea (server.rs:2905 vs :5877) — a shared helper would drop ~15 lines. Not blocking; the two differ in source_id and complete-only semantics.
- FYI: **CREATE_NO_WINDOW is absent at every spawn site in the crate** (rg: zero hits) — new code is consistent with the house pattern; if console flashing is ever addressed it's a crate-wide fix, not a subs issue.
- FYI: extraction output size is unbounded in principle but bounded in practice by subtitle-stream nature (text tracks are KB–MB; the 120s timeout is the real cap).

## Dead code
None introduced. No orphaned helpers; all seven pure helpers have call sites + tests.

## Verified vs assumed
Verified by reading live source: guard lock discipline, folder_id validation, memo write conditions, startup cleanup paths, arg-builder call sites, route registration order (`list` registered before `{stream_idx}`; Actix matches literal-vs-typed segments correctly here since `"list"` fails i32 extraction and falls through — also covered by registration order). Assumed (not executed): actual Actix routing under load; live ffmpeg behavior is covered by the execution-verified research docs (`subs-execution-bytecost.md`).
