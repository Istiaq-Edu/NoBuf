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
const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError, info: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

import { stageDroppedFiles } from '../hooks/useDroppedFileUpload';
import { persistableQueueItems, cleanupStagedTemp } from '../hooks/useFileUpload';
import type { QueueItem } from '../types';

/** Minimal stand-in for the Rust command: returns "" until isLast, then the temp path.
 *  Optionally serves cmd_staging_free_space (number) or makes it throw (Error instance). */
function fakeStageBackend(freeSpace?: number | Error) {
    const writes = new Map<string, Uint8Array>();
    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
        if (_cmd === 'cmd_staging_free_space') {
            if (freeSpace instanceof Error) throw freeSpace;
            return freeSpace;
        }
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
    toastError.mockClear();
});

describe('stageDroppedFiles', () => {
    it('stages a small file in one chunk and preserves its ORIGINAL name', async () => {
        const writes = fakeStageBackend();
        const payload = [1, 2, 3, 250, 251, 0, 42];
        const items = await stageDroppedFiles(
            [makeFile(payload, 'রিপোর্ট.pdf')], 7, 2_000_000_000, false,
        );
        // 1 free-space probe + 1 staging chunk
        expect(invokeMock).toHaveBeenCalledTimes(2);
        const args = invokeMock.mock.calls.find(c => c[0] === 'cmd_stage_dropped_file')![1];
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
        // 1 free-space probe + 2 staging chunks; chunks are calls [1] and [2]
        expect(invokeMock).toHaveBeenCalledTimes(3);
        const stageCalls = invokeMock.mock.calls.filter(c => c[0] === 'cmd_stage_dropped_file');
        expect(stageCalls.length).toBe(2);
        expect(stageCalls[0][1].isLast).toBe(false);
        expect(stageCalls[1][1].chunkIndex).toBe(1);
        expect(stageCalls[1][1].isLast).toBe(true);
        const staged = writes.get(`${stageCalls[0][1].uploadId}::big.bin`)!;
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

    describe('staging free-space pre-flight', () => {
        it('rejects files larger than temp-drive headroom, naming them, and stages the rest', async () => {
            // Free space must sit BETWEEN small.txt's requirement (1B + 256MB margin)
            // and big.mkv's (~900KB + margin) so exactly one file is rejected.
            const writes = fakeStageBackend(268_800_000);
            const items = await stageDroppedFiles(
                [makeFile(new Array(900 * 1024).fill(1), 'big.mkv'), makeFile([2], 'small.txt')],
                7, 2_000_000_000, false,
            );
            expect(items.map(i => i.displayName)).toEqual(['small.txt']);
            expect(writes.size).toBe(1);
            const call = toastError.mock.calls.find(c => String(c[0]).includes('big.mkv'));
            expect(call).toBeDefined();
            expect(String(call![0])).toContain('temp drive');
            expect(String(call![0])).toContain('0.3 GB free');
        });

        it('proceeds un-gated when the probe fails', async () => {
            const writes = fakeStageBackend(new Error('probe down'));
            const items = await stageDroppedFiles(
                [makeFile([9, 9, 9], 'fallback.bin')], 7, 2_000_000_000, false,
            );
            expect(items).toHaveLength(1);                       // NOT blocked by a dead probe
            expect([...writes.values()][0].length).toBe(3);      // and actually staged
            expect(toastError).not.toHaveBeenCalledWith(expect.stringContaining('temp drive'));
        });

        it('256MB safety margin keeps just-fitting files out of the rejection', async () => {
            // File (1 KB) + margin (256 MB) must fit under mocked free space.
            // Scaled-down fixture exercises the same comparison without allocating
            // hundreds of MB in the suite (a 300 MB array OOMs the full vitest run).
            const writes = fakeStageBackend(257 * 1024 * 1024);
            const items = await stageDroppedFiles(
                [makeFile(new Array(1024).fill(65), 'fits.mkv'), makeFile([1], 'tiny.txt')],
                7, 2_000_000_000, false,
            );
            expect(items.map(i => i.displayName)).toEqual(['fits.mkv', 'tiny.txt']); // 1KB+256MB < 257MB
            expect(writes.size).toBe(2);
        });
    });
});
