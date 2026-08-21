// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Regression guards for the external drag-drop upload pipeline (commit 522e18b follow-up fixes).
//
// Shipped defects being pinned here:
//  1. Staged temp files (%TEMP%\nobuf_dropped) were never deleted at runtime — every dropped
//     byte leaked until the next app launch. Fix: cleanupStagedTemp on terminal states +
//     staged items excluded from store persistence (a restart sweeps the dir before restore,
//     so persisted temp paths were guaranteed "Invalid path" failure toasts).
//  2. Uploads landed in Telegram named after the <randomId>-prefixed TEMP filename.
//     Fix: QueueItem.displayName rides through cmd_upload_file as display_name.
//  3. Chunks traveled as JSON number arrays (~30-40 MB IPC string per 8 MB chunk).
//     Fix: base64 transport (~10.7 MB), verified here by decoding what the frontend sends.
//  4. Accidental double-drop uploaded everything twice. Fix: dedupe against active queue.

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { stageDroppedFiles } from '../hooks/useDroppedFileUpload';
import { persistableQueueItems, cleanupStagedTemp } from '../hooks/useFileUpload';
import type { QueueItem } from '../types';

/** Minimal stand-in for the Rust command: returns "" until isLast, then the temp path. */
function fakeStageBackend() {
    const writes = new Map<string, Uint8Array>();
    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
        if (_cmd !== 'cmd_stage_dropped_file') return undefined;
        const bin = Uint8Array.from(atob(args.bytesB64), c => c.charCodeAt(0));
        const key = `${args.uploadId}::${args.fileName}`;
        const prev = writes.get(key) ?? new Uint8Array(0);
        const merged = new Uint8Array(prev.length + bin.length);
        merged.set(prev); merged.set(bin, prev.length);
        writes.set(key, merged);
        if (args.isLast) {
            return `C:\\Users\\t\\AppData\\Local\\Temp\\nobuf_dropped\\${args.uploadId}-${args.fileName}`;
        }
        return '';
    });
    return writes;
}

function makeFile(bytes: number[], name: string): File {
    return new File([new Uint8Array(bytes)], name, { type: 'application/octet-stream' });
}

beforeEach(() => {
    invokeMock.mockReset();
});

describe('stageDroppedFiles', () => {
    it('stages a small file in one chunk and preserves its ORIGINAL name', async () => {
        const writes = fakeStageBackend();
        const payload = [1, 2, 3, 250, 251, 0, 42];
        const items = await stageDroppedFiles(
            [makeFile(payload, 'রিপোর্ট.pdf')], 7, 2_000_000_000, false,
        );
        expect(invokeMock).toHaveBeenCalledTimes(1);
        const args = invokeMock.mock.calls[0][1];
        expect(args.chunkIndex).toBe(0);
        expect(args.isLast).toBe(true);
        // base64 round-trip: what arrived backend-side is exactly the file's bytes
        expect(Array.from(writes.get(`${args.uploadId}::রিপোর্ট.pdf`)!)).toEqual(payload);
        expect(items).toHaveLength(1);
        expect(items[0].displayName).toBe('রিপোর্ট.pdf');       // NOT the <id>-prefixed temp name
        expect(items[0].stagedTempPath).toBe(items[0].path);   // marked for runtime cleanup
        expect(items[0].folderId).toBe(7);
        expect(items[0].status).toBe('pending');
    });

    it('chunks large files at 8 MB boundaries and reassembles byte-exact', async () => {
        const writes = fakeStageBackend();
        const total = 8 * 1024 * 1024 + 1000; // 2 chunks: full + remainder
        const big = new Array(total);
        for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 256;
        const items = await stageDroppedFiles([makeFile(big, 'big.bin')], null, 4_000_000_000, false);
        expect(invokeMock).toHaveBeenCalledTimes(2);
        expect(invokeMock.mock.calls[0][1].isLast).toBe(false);
        expect(invokeMock.mock.calls[1][1].chunkIndex).toBe(1);
        expect(invokeMock.mock.calls[1][1].isLast).toBe(true);
        const staged = writes.get(`${invokeMock.mock.calls[0][1].uploadId}::big.bin`)!;
        expect(staged.length).toBe(total);
        expect(items[0].folderId).toBeNull(); // Saved Messages root passes null through
    }, 30_000);

    it('rejects folder drops all-or-nothing WITHOUT staging anything', async () => {
        fakeStageBackend();
        const items = await stageDroppedFiles(
            [makeFile([1], 'valid.txt')], 1, 2_000_000_000, true,
        );
        expect(items).toHaveLength(0);
        expect(invokeMock).not.toHaveBeenCalled();
    });

    it('filters empty and oversized files by NAME-bearing rules, stages survivors', async () => {
        fakeStageBackend();
        const items = await stageDroppedFiles(
            [
                makeFile([], 'empty.bin'),
                makeFile(new Array(50).fill(9), 'huge.bin'),
                makeFile([5, 6], 'keeper.txt'),
            ],
            3, 40 /* tiny limit makes huge.bin oversized */, false,
        );
        expect(items).toHaveLength(1);
        expect(items[0].displayName).toBe('keeper.txt');
    });

    it('skips a file whose staging fails mid-stream but still stages the rest', async () => {
        fakeStageBackend();
        invokeMock.mockImplementation(async (_cmd: string, args: any) => {
            if (args.fileName === 'cursed.dat') throw new Error('read fault');
            return args.isLast ? `C:\\tmp\\nobuf_dropped\\${args.uploadId}-${args.fileName}` : '';
        });
        const items = await stageDroppedFiles(
            [makeFile([1], 'cursed.dat'), makeFile([2], 'fine.txt')], 1, 2_000_000_000, false,
        );
        expect(items).toHaveLength(1);
        expect(items[0].displayName).toBe('fine.txt');
        // Partial staging bytes are discarded immediately, not left for the next sweep.
        const discardCall = invokeMock.mock.calls.find(c => c[0] === 'cmd_discard_staged_upload');
        expect(discardCall).toBeDefined();
        expect(discardCall![1]).toMatchObject({ fileName: 'cursed.dat' });
        expect(typeof discardCall![1].uploadId).toBe('string');
    });
});

describe('staged-item lifecycle', () => {
    it('persistableQueueItems excludes staged drops but keeps picker + remote items', () => {
        const staged: QueueItem = { id: 'a', path: 'C:\\tmp\\nobuf_dropped\\abc-f.pdf', folderId: null, status: 'pending', stagedTempPath: 'C:\\tmp\\nobuf_dropped\\abc-f.pdf', displayName: 'f.pdf' };
        const picker: QueueItem = { id: 'b', path: 'D:\\Downloads\\real.zip', folderId: 2, status: 'pending' };
        const remote: QueueItem = { id: 'c', path: '', url: 'https://x/y.mp4', folderId: 2, status: 'pending', phase: 'downloading' };
        const kept = persistableQueueItems([staged, picker, remote]);
        expect(kept.map(i => i.id)).toEqual(['b', 'c']);
    });

    it('cleanupStagedTemp deletes via the guarded command only when marked staged', async () => {
        invokeMock.mockResolvedValue(undefined); // production invoke always returns a promise
        const staged: QueueItem = { id: 'a', path: 'C:\\tmp\\nobuf_dropped\\abc-f.pdf', folderId: null, status: 'success', stagedTempPath: 'C:\\tmp\\nobuf_dropped\\abc-f.pdf' };
        cleanupStagedTemp(staged);
        expect(invokeMock).toHaveBeenCalledWith('cmd_delete_staged_file', { path: staged.stagedTempPath });

        invokeMock.mockClear();
        const picker: QueueItem = { id: 'b', path: 'D:\\Downloads\\real.zip', folderId: 2, status: 'success' };
        cleanupStagedTemp(picker);
        expect(invokeMock).not.toHaveBeenCalled(); // NEVER delete user's real files
    });
});
