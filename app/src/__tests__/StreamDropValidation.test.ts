import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
const toastError = vi.hoisted(() => vi.fn());
const toastInfo = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError, info: toastInfo } }));

import { streamDroppedFiles, retryDropStream } from '../hooks/useDropStreamUpload';

function makeFile(size: number, name = 'a.bin'): File {
    // Blob-backed File whose .size reports `size` (content stays tiny).
    const f = new File([new Uint8Array(Math.min(size, 8))], name);
    Object.defineProperty(f, 'size', { value: size });
    return f;
}

const BASE = { token: 'tok-123', base_url: 'http://localhost:14201', video_base_url: '', alive: true };

beforeEach(() => {
    invokeMock.mockReset();
    toastError.mockClear();
    toastInfo.mockClear();
    // cmd_get_stream_info: what the real Tauri backend returns.
    invokeMock.mockImplementation(async (cmd: string) =>
        cmd === 'cmd_get_stream_info' ? BASE : undefined);
    // Default: server reachable with the route (HEAD -> 405).
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 405 })));
});

describe('streamDroppedFiles validation', () => {
    it('rejects folders all-or-nothing before any other check', async () => {
        const items = await streamDroppedFiles([makeFile(10)], 1, 2_000_000_000, true);
        expect(items).toHaveLength(0);
        expect(toastError).toHaveBeenCalledWith(expect.stringContaining("Folders aren't supported"));
        expect(fetch).not.toHaveBeenCalled();
    });

    it('names empty and oversized rejects, caps at 3 + "+N more", stages none', async () => {
        const files = [
            makeFile(0, 'e1.txt'),
            makeFile(3_000_000_000, 'big1.mkv'),
            makeFile(0, 'e2.txt'),
            makeFile(3_500_000_000, 'big2.mkv'),
            makeFile(10, 'ok.bin'),
        ];
        const items = await streamDroppedFiles(files, null, 2_000_000_000, false);
        expect(items).toHaveLength(1);
        expect(items[0].displayName).toBe('ok.bin');
        const errTexts = toastError.mock.calls.map(c => String(c[0]));
        expect(errTexts.some(t => t.includes('e1.txt, e2.txt') && t.includes('empty'))).toBe(true);
        expect(errTexts.some(t => t.includes('big1.mkv, big2.mkv') && t.includes('2 GB limit'))).toBe(true);
    });

    it('caps long rejection lists at three names plus a count', async () => {
        const files = Array.from({ length: 5 }, (_, i) => makeFile(0, `f${i}.txt`));
        await streamDroppedFiles(files, null, 2_000_000_000, false);
        expect(toastError).toHaveBeenCalledTimes(1);
        const msg = String(toastError.mock.calls[0][0]);
        expect(msg).toContain('f0.txt, f1.txt, f2.txt');
        expect(msg).toContain('+2 more');
        expect(msg).not.toContain('f4.txt');
    });
});

describe('probe fallback (two-step classifier)', () => {
    it('throws /not reachable/ when server down AND this session did not bind', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('refused'); }));
        invokeMock.mockImplementation(async (cmd: string) =>
            cmd === 'cmd_get_stream_info' ? { ...BASE, alive: false } : undefined);
        await expect(streamDroppedFiles([makeFile(10)], 1, 2_000_000_000, false))
            .rejects.toThrow(/not reachable/);
    });

    it('throws /held by another NoBuf instance/ when port answers but we did not bind (zombie)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ status: 404 })));
        invokeMock.mockImplementation(async (cmd: string) =>
            cmd === 'cmd_get_stream_info'
                ? { ...BASE, alive: false }  // liveness resolved, but not OUR bind
                : undefined);
        await expect(streamDroppedFiles([makeFile(10)], 1, 2_000_000_000, false))
            .rejects.toThrow(/held by another NoBuf instance/);
    });

    it('throws on 404 — old binary without the route must fall back too', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ status: 404 })));
        await expect(streamDroppedFiles([makeFile(10)], 1, 2_000_000_000, false))
            .rejects.toThrow(/route missing/);
    });

    it('throws /webview blocked/ when fetch rejects but the Rust side IS bound', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('refused'); }));
        invokeMock.mockImplementation(async (cmd: string) =>
            cmd === 'cmd_get_stream_info' ? { ...BASE, alive: true } : undefined);
        await expect(streamDroppedFiles([makeFile(10)], 1, 2_000_000_000, false))
            .rejects.toThrow(/webview blocked/);
    });

    it('accepts 405 — route exists, wrong method is the expected probe answer', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ status: 405 })));
        const items = await streamDroppedFiles([makeFile(10)], 1, 2_000_000_000, false);
        expect(items).toHaveLength(1);
    });
});

describe('dedupe before XHR', () => {
    it('skips names already active for the same destination, keeps others', async () => {
        const activeKeys = new Set(['root::dup.bin']);
        const items = await streamDroppedFiles(
            [makeFile(10, 'dup.bin'), makeFile(11, 'fresh.bin')],
            null, 2_000_000_000, false, activeKeys,
        );
        expect(items.map(i => i.displayName)).toEqual(['fresh.bin']);
        expect(toastInfo).toHaveBeenCalledWith(expect.stringContaining('duplicate'));
    });

    it('same name into a DIFFERENT destination is not a duplicate', async () => {
        const items = await streamDroppedFiles(
            [makeFile(10, 'doc.pdf')], 7, 2_000_000_000, false, new Set(['root::doc.pdf']),
        );
        expect(items).toHaveLength(1);
        expect(items[0].folderId).toBe(7);
    });
});

describe('retry routing truth table', () => {
    const marker = { path: 'nobuf-drop-stream://x.bin' };

    it('returns false for non-marker items (caller uses legacy path)', () => {
        expect(retryDropStream({ path: 'C:\\file.bin' } as never)).toBe(false);
    });

    it('returns true but toasts when the live handle is gone', async () => {
        const { forgetLiveDrop } = await import('../hooks/useDropStreamUpload');
        // Ensure no handle registered for this id.
        forgetLiveDrop('drop-nonexistent');
        expect(retryDropStream({ ...marker, id: 'drop-nonexistent' } as never)).toBe(true);
        expect(toastError).toHaveBeenCalledWith(expect.stringContaining('handle lost'));
    });
});
