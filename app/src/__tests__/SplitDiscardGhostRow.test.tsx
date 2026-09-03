// @vitest-environment jsdom
/**
 * Ghost-row bug pins (discard mid-run): after removeSplitRow(jobId) the dying
 * worker's late events must NOT resurrect the row — every action on a
 * resurrected row 404s ("Job not found") because the backend already deleted
 * the DB row. Binds to the SHIPPED module store through the real hook +
 * captured Tauri event listeners (nobuf-vitest-testing: a test that
 * re-models the store locally proves nothing).
 *
 * Both listener paths are pinned: `split-progress` (the original
 * resurrection path — unconditional upsert) and `upload-progress` (safe
 * today only via its own splitRows.get early-return, an invariant that could
 * regress silently under a future "simplification").
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { eventHandlers } = vi.hoisted(() => ({
    eventHandlers: {} as Record<string, (ev: { payload: Record<string, unknown> }) => void>,
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(async () => [] as unknown[]),
}));
vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn(async (name: string, cb: (ev: { payload: Record<string, unknown> }) => void) => {
        eventHandlers[name] = cb;
        return () => {};
    }),
}));
vi.mock('sonner', () => ({
    toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import { __resetSplitRowsForTests, removeSplitRow, useSplitUpload } from '../hooks/useSplitUpload';

afterEach(() => {
    // House rule (SplitJobResumeActions.test.tsx precedent): auto-cleanup
    // never registers (no setupFiles, globals off) — call it explicitly.
    // The module store reset keeps splitRows/tombstones from bleeding across
    // tests now that this file has more than one.
    cleanup();
    __resetSplitRowsForTests();
    vi.clearAllMocks();
});

function fireSplitProgress(jobId: string, phase: string) {
    const handler = eventHandlers['split-progress'];
    if (!handler) throw new Error('split-progress listener not attached');
    act(() => {
        handler({
            payload: {
                jobId,
                phase,
                partIdx: 1,
                totalParts: 2,
                message: 'Movie.part01.mkv',
                partStatus: null,
                messageId: null,
            },
        });
    });
}

function fireUploadProgress(jobId: string, idx: number) {
    const handler = eventHandlers['upload-progress'];
    if (!handler) throw new Error('upload-progress listener not attached');
    act(() => {
        handler({
            payload: {
                id: `split:${jobId}:${idx}`,
                percent: 42,
                uploaded_bytes: 100,
                total_bytes: 200,
                speed_bytes_per_sec: 10,
            },
        });
    });
}

describe('split discard ghost-row suppression', () => {
    it('late split-progress events cannot resurrect a discarded job row', async () => {
        const { result } = renderHook(() => useSplitUpload());
        // Let the async listener attach + initial hydration settle.
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(eventHandlers['split-progress']).toBeTruthy();

        // Worker emits → live row appears.
        fireSplitProgress('deadbeef', 'uploading');
        expect(result.current.splitJobRows.map(r => r.jobId)).toContain('deadbeef');

        // User discards → row leaves the panel immediately.
        act(() => { removeSplitRow('deadbeef'); });
        expect(result.current.splitJobRows.map(r => r.jobId)).not.toContain('deadbeef');

        // The dying worker's late events arrive AFTER the discard — the ghost
        // row must NOT come back (this exact resurrection produced rows whose
        // every action failed with "Job not found").
        fireSplitProgress('deadbeef', 'uploading');
        fireSplitProgress('deadbeef', 'splitting');
        expect(result.current.splitJobRows.map(r => r.jobId)).not.toContain('deadbeef');

        // The tombstone is per-job: other jobs keep flowing.
        fireSplitProgress('cafebabe', 'uploading');
        expect(result.current.splitJobRows.map(r => r.jobId)).toContain('cafebabe');
    });

    it('late upload-progress events cannot resurrect a discarded job row', async () => {
        const { result } = renderHook(() => useSplitUpload());
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(eventHandlers['upload-progress']).toBeTruthy();

        // Live row appears, then a per-part byte-progress event lands on it.
        fireSplitProgress('feedface', 'uploading');
        fireUploadProgress('feedface', 1);
        expect(result.current.splitJobRows.map(r => r.jobId)).toContain('feedface');

        // Discard, then the dying worker's late byte-progress event arrives.
        act(() => { removeSplitRow('feedface'); });
        fireUploadProgress('feedface', 1);
        expect(result.current.splitJobRows.map(r => r.jobId)).not.toContain('feedface');
    });
});
