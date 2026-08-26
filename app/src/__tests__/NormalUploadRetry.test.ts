import { describe, expect, it, vi } from 'vitest';
import { retryUploadItem } from '../hooks/useFileUpload';
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
