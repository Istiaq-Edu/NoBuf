import { describe, expect, it, vi } from 'vitest';
import { retryUploadItem, reviveSavedUploads } from '../hooks/useFileUpload';
import { splitPlanToQueuedRow, type SplitPlan } from '../hooks/useSplitUpload';
import type { QueueItem } from '../types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));

const base: QueueItem = {
    id: 'upload-1',
    path: 'D:/movie.mkv',
    folderId: null,
    status: 'cancelled',
    error: 'Transfer cancelled',
    progress: 64,
    uploadedBytes: 64,
    totalBytes: 100,
    speedBytesPerSec: 10,
};

describe('retryUploadItem', () => {
    it('requeues a cancelled upload in one transition and clears stale progress', () => {
        expect(retryUploadItem(base)).toEqual({
            id: 'upload-1',
            path: 'D:/movie.mkv',
            folderId: null,
            status: 'pending',
            error: undefined,
            progress: undefined,
            uploadedBytes: undefined,
            totalBytes: undefined,
            speedBytesPerSec: undefined,
        });
    });

    it('leaves active and successful uploads unchanged', () => {
        const active = { ...base, status: 'uploading' as const };
        const done = { ...base, status: 'success' as const };
        expect(retryUploadItem(active)).toBe(active);
        expect(retryUploadItem(done)).toBe(done);
    });
});

describe('splitPlanToQueuedRow', () => {
    it('makes a newly-created split job visible before its first progress event', () => {
        const plan: SplitPlan = {
            sourcePath: 'D:/movie.mkv',
            sourceSize: 300,
            displayName: 'movie',
            folderId: 7,
            capBytes: 100,
            durationSec: 300,
            container: 'matroska',
            partExt: 'mkv',
            mapAll: true,
            streamNotice: null,
            boundaries: [100, 200],
            thumbs: [],
            parts: [
                { idx: 1, name: 'movie.part01.mkv', startSec: 0, endSec: 100 },
                { idx: 2, name: 'movie.part02.mkv', startSec: 100, endSec: 200 },
                { idx: 3, name: 'movie.part03.mkv', startSec: 200, endSec: 300 },
            ],
        };

        expect(splitPlanToQueuedRow('job-1', plan)).toMatchObject({
            jobId: 'job-1',
            phase: 'queued',
            totalParts: 3,
            folderId: 7,
            parts: [
                { idx: 1, status: 'waiting', sizeBytes: 100 },
                { idx: 2, status: 'waiting', sizeBytes: 100 },
                { idx: 3, status: 'waiting', sizeBytes: 100 },
            ],
        });
    });
});

describe('reviveSavedUploads (crash recovery shape)', () => {
    const item = (over: Partial<QueueItem>): QueueItem => ({
        id: 'x1', path: 'D:/a.mkv', folderId: null, status: 'pending', ...over,
    });

    it('maps an interrupted uploading row to retryable cancelled with an interruption note', () => {
        const [revived] = reviveSavedUploads([item({
            id: 'u1', status: 'uploading', progress: 72, uploadedBytes: 720, speedBytesPerSec: 50,
        })]);
        expect(revived.status).toBe('cancelled');
        expect(revived.error).toBe('Interrupted when the app closed');
        expect(revived.progress).toBeUndefined();
        expect(revived.uploadedBytes).toBeUndefined();
        expect(revived.speedBytesPerSec).toBeUndefined();
    });

    it('keeps pending, error, and cancelled rows as-is (retryable)', () => {
        const rows = [
            item({ id: 'p1', status: 'pending' }),
            item({ id: 'e1', status: 'error', error: 'Network down' }),
            item({ id: 'c1', status: 'cancelled' }),
        ];
        expect(reviveSavedUploads(rows)).toEqual(rows);
    });

    it('drops unrecoverable rows: stream-direct drops and staged temps', () => {
        const rows = [
            item({ id: 's1', path: 'nobuf-drop-stream://a.mkv', status: 'uploading' }),
            item({ id: 's2', stagedTempPath: 'C:/temp/x.bin', status: 'pending' }),
        ];
        expect(reviveSavedUploads(rows)).toEqual([]);
    });

    it('drops terminal success rows (they live in the folder listing, not the queue)', () => {
        expect(reviveSavedUploads([item({ id: 'ok1', status: 'success', messageId: 42 })])).toEqual([]);
    });
});
