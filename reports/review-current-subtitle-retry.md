# Review — subtitle retry and cold-start inventory change

## Verdict

**Request changes**

The diff compiles and the full automated gates are green, but the central post-seek retry behavior is not actually driven by the new 1-second timer. The tests prove pure predicate values and source text, not the runtime lifecycle that controls whether the retry occurs.

## Findings

### Required: deferred subtitle retry can remain stuck while paused

`app/src/components/dashboard/FastStreamPlayer.tsx:1892-1901` clears `subRepairAttemptedRef` after `subRepairRegionRetryDelay('deferred')`, while the actual repair is initiated only from `maybeRepairSubCoverageRef` at `FastStreamPlayer.tsx:1763-1793`, which is called from the video's `timeupdate` handler at `FastStreamPlayer.tsx:1056-1062`.

Changing `SUB_REPAIR_DEFER_RETRY_MS` from 5 seconds to 1 second only changes when the region ledger is cleared. It does not schedule a repair at one second. If the user seeks while paused, or if the video produces no `timeupdate` events during the gap, the ledger can be cleared but no follow-up extraction runs. The subtitle remains absent indefinitely until another timeupdate-producing event occurs.

The existing unit test only calls `shouldAttemptSubRepair()` directly. It does not bind to `maybeRepairSubCoverageRef`, the timer callback, or a paused-video scenario.

**Required correction:** either schedule a bounded retry that invokes the production repair admission path, or explicitly use a stable cache/progress poll as the retry driver. Add a runtime-bound pure seam/test proving a deferred result causes a later repair attempt even when playback is paused.

### Required: the 1-second change silently reduces the defer patience budget

`app/src/hooks/useMSEPlayer.ts:856-869` keeps `SUB_REPAIR_MAX_DEFERS = 12` while changing the delay to `1_000ms`. This changes the maximum defer window from approximately 60 seconds to approximately 12 seconds.

That is a behavioral policy change, not just a latency improvement. A slow Telegram download or a busy cache coordinator can legitimately need more than 12 seconds to grow a usable island. After the twelfth defer, `reduceSubRepairBreaker()` moves into the failure ladder and can eventually open the breaker, despite the target data still progressing.

The comment says 12 seconds is above the observed 7-second recovery, but one observed recovery does not establish a safe upper bound for network/cache variability. The tests only prove that the counter is bounded; they do not prove that the new 12-second bound is adequate.

**Required correction:** preserve the previous patience window by increasing the defer count when lowering the interval, or make the defer budget explicitly time-based (for example, a maximum elapsed supply-wait duration) and test that policy. Do not alter the effective patience accidentally through two coupled constants.

### Required: cold-start test is structural, not behavioral

`app/src/__tests__/Round37Lifecycle.test.ts:46-53` asserts that source text contains `state.current.initialized`, a 20-second timeout, and cleanup text. It does not execute the effect, mock `state.current.initialized` transitions, verify that `loadEmbeddedSubTracks()` is called after initialization, or prove that the fixed 1.5-second path is absent from the active behavior.

`state.current.initialized` is set in multiple pipeline-specific locations (`useMSEPlayer.ts:5183`, `8096`, and `9179`). Those assignments mean pipeline setup/segmentation initialization, not necessarily first-frame presentation. The change may still be useful for reducing probe contention, but the test cannot establish the claimed startup behavior.

**Required correction:** extract/test the scheduling decision as a production-bound helper, or use a hook test with fake timers and a mocked loader. Cover initialized-before-effect, initialized-after-effect, fallback-at-20s, cleanup-before-init, and file/reinit cancellation.

## Verified

- Full Vitest: 67 files, 744 tests passed.
- Rust tests: 276 passed.
- TypeScript: passed.
- `git diff --check`: passed.
- Mutation of the 5-second constant made the timing test fail.
- Mutation of the old fixed inventory timer made the structural test fail.

## What remains unproven

- A deferred subtitle extraction retries while playback is paused.
- The one-second retry policy preserves acceptable patience under slow cache growth.
- The inventory request ordering improves real first-frame latency in Tauri/WebView2.
- The 12-second timestamp overshoot during remux seeks is addressed; it remains a separate issue.
