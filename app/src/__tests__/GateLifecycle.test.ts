/**
 * Mutation killers for round-3 fixes (ship-gate audit, deleg_6f50574f).
 *
 * Mutant 1: revert `cancelledBeforeStart.delete(id)` in dequeueStart ->
 *           a cancelled QUEUED drop resurrects and uploads (send called).
 * Mutant 2: revert the plain-text error fix in startOne's onload ->
 *           real server reasons collapse to "Server error 400".
 *
 * Strategy: stub XMLHttpRequest with a fake class that records send() calls
 * and lets tests drive onload/onerror manually. The module-level gate state
 * (activeDrops/pendingDrops) has no reset hook, so these tests only ever
 * START uploads they also COMPLETE — leaving the gate fully drained.
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError, info: vi.fn() } }));

type FakeXhr = {
    open: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    status: number;
    responseText: string;
    timeout: number;
    onerror: (() => void) | null;
    onabort: (() => void) | null;
    onload: (() => void) | null;
};

let sentXhrs: FakeXhr[];

// Deterministic stream-info; probe passes (HEAD -> 405).
invokeMock.mockImplementation(async (cmd: string) =>
    cmd === 'cmd_get_stream_info'
        ? { token: 'tok', base_url: 'http://127.0.0.1:14201', video_base_url: '', alive: true }
        : undefined);

function makeFile(size: number, name: string): File {
    const f = new File([new Uint8Array(4)], name);
    Object.defineProperty(f, 'size', { value: size });
    return f;
}

async function drop(files: File[]) {
    const { streamDroppedFiles } = await import('../hooks/useDropStreamUpload');
    return streamDroppedFiles(files, null, 4_000_000_000, false);
}

/** Drain the gate: complete every XHR that has been sent so far. */
function completeAll(status: number, responseText = '') {
    for (const x of sentXhrs) {
        if (!x.onload) continue;
        x.status = status;
        x.responseText = responseText;
        const cb = x.onload;
        x.onload = null;
        cb();
    }
}

beforeEach(() => {
    sentXhrs = [];
    toastError.mockClear();
    // Probe must pass: both HEADs answer 405 (route exists, wrong method).
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 405 })));
    vi.stubGlobal('XMLHttpRequest', function (this: FakeXhr) {
        const xhr: FakeXhr = this;
        xhr.open = vi.fn();
        xhr.send = vi.fn(() => { sentXhrs.push(xhr); });
        xhr.abort = vi.fn();
        xhr.status = 0;
        xhr.responseText = '';
        xhr.timeout = 0;
        return xhr;
    } as unknown as typeof XMLHttpRequest);
});

describe('queued-cancel does not resurrect (mutant 1)', () => {
    it('cancelDropStream on a gate-queued later file keeps it dead forever', async () => {
        const { cancelDropStream } = await import('../hooks/useDropStreamUpload');
        const doneEvents: CustomEvent[] = [];
        const listener = (e: Event) => doneEvents.push(e as CustomEvent);
        window.addEventListener('nobuf-drop-done', listener);

        // MAX_PARALLEL_DROPS = 1: only a.bin starts; b/c/d wait in FIFO order
        // — sequential queue, matching the original upload system.
        const items = await drop([
            makeFile(10, 'a.bin'), makeFile(10, 'b.bin'),
            makeFile(10, 'c.bin'), makeFile(10, 'd.bin'),
        ]);
        await Promise.resolve(); let ticks = 20; while (ticks--) await Promise.resolve();
        expect(sentXhrs).toHaveLength(1); // cap enforced: strictly sequential

        // Cancel d.bin WHILE it is still queued.
        cancelDropStream(items[3].id);
        await Promise.resolve(); let t2 = 20; while (t2--) await Promise.resolve();
        expect(sentXhrs).toHaveLength(1); // still nothing new started

        // Finish a.bin -> gate dequeues b... and must SKIP d.bin when its turn comes.
        completeAll(200);
        await Promise.resolve(); let t3 = 40; while (t3--) await Promise.resolve();

        // a finished, b started, c+d skipped-or-waiting; d must NEVER start.
        expect(sentXhrs).toHaveLength(2); // MUTANT: would be 3 here (d resurrects)
        const statuses = doneEvents.map(e => (e.detail as { id: string }).id);
        expect(statuses).toContain(items[0].id);
        expect(statuses).not.toContain(items[3].id); // never uploaded, never errored
        window.removeEventListener('nobuf-drop-done', listener);

        // Drain the gate fully so module state is clean for the next test.
        let guard = 10;
        while (sentXhrs.some(x => x.onload) && guard--) {
            completeAll(200);
            await Promise.resolve(); let t4 = 40; while (t4--) await Promise.resolve();
        }
    });
});

describe('plain-text server error wins (mutant 2)', () => {
    it('surfaces responseText reason, not "Server error 400"', async () => {
        const [item] = await drop([makeFile(10, 'big.mkv')]);
        let ticks = 20; while (ticks--) await Promise.resolve();

        const doneEvents: CustomEvent[] = [];
        const listener = (e: Event) => doneEvents.push(e as CustomEvent);
        window.addEventListener('nobuf-drop-done', listener);

        completeAll(400, 'Daily bandwidth limit exceeded');
        await Promise.resolve(); let t2 = 20; while (t2--) await Promise.resolve();

        const detail = doneEvents.find(e => (e.detail as { id: string }).id === item.id)?.detail as { status: string; error?: string };
        expect(detail.status).toBe('error');
        expect(detail.error).toBe('Daily bandwidth limit exceeded'); // MUTANT: 'Server error 400'
        window.removeEventListener('nobuf-drop-done', listener);
    });

    it('prefers parsed .error when body IS json, falls back to raw text', async () => {
        const [item] = await drop([makeFile(10, 'j.json')]);
        let ticks = 20; while (ticks--) await Promise.resolve();

        const doneEvents: CustomEvent[] = [];
        const listener = (e: Event) => doneEvents.push(e as CustomEvent);
        window.addEventListener('nobuf-drop-done', listener);

        completeAll(500, JSON.stringify({ error: 'structured reason' }));
        await Promise.resolve(); let t2 = 20; while (t2--) await Promise.resolve();

        const detail = doneEvents.find(e => (e.detail as { id: string }).id === item.id)?.detail as { error?: string };
        expect(detail.error).toBe('structured reason');
        window.removeEventListener('nobuf-drop-done', listener);
    });
});
