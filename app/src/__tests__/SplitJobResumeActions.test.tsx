// @vitest-environment jsdom
/**
 * Phase E acceptance: interrupted split jobs expose Resume + Discard actions in
 * the Transfers panel, and only those rows. Active/queued/done/cancelled rows
 * stay action-less (cancel button on active rows is pre-existing behavior).
 *
 * Binds to the SHIPPED component (nobuf-vitest-testing rule: a test that
 * re-models the row locally proves nothing) and asserts through the DOM.
 * jest-dom matchers are NOT registered in this repo — raw DOM assertions only.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TransferPanel, SplitPartRowView } from '../components/dashboard/TransferPanel';
import {
    selectResumableJobs,
    parseSplitUploadTid,
    computeCombinedProgress,
} from '../hooks/useSplitUpload';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));

afterEach(cleanup);

const baseProps = {
    isOpen: true,
    onClose: () => {},
    uploadItems: [],
    onClearUploadFinished: () => {},
    onCancelAllUploads: () => {},
    onCancelUploadItem: () => {},
    onRetryUploadItem: () => {},
    downloadItems: [],
    onClearDownloadFinished: () => {},
    onCancelAllDownloads: () => {},
    onCancelDownloadItem: () => {},
    onRetryDownloadItem: () => {},
};

function makeJob(phase: string) {
    return {
        jobId: `job-${phase}`,
        displayName: `Movie ${phase}.mkv`,
        phase,
        doneParts: 1,
        totalParts: 3,
        currentPart: '',
    };
}

describe('TransferPanel split-job resume/discard actions (Phase E)', () => {
    it('interrupted rows show Resume and Discard; clicking them invokes the wired handlers', async () => {
        const onResume = vi.fn();
        const onDiscard = vi.fn();
        const { container } = render(
            <TransferPanel
                {...baseProps}
                splitJobs={[makeJob('interrupted')]}
                onResumeSplitJob={onResume}
                onDiscardSplitJob={onDiscard}
            />,
        );
        const buttons = Array.from(container.querySelectorAll('button'));
        const resume = buttons.find(b => b.title.startsWith('Resume this split job'));
        const discard = buttons.find(b => b.title.startsWith('Discard this job'));
        expect(resume, 'resume button must exist on an interrupted row').toBeTruthy();
        expect(discard, 'discard button must exist on an interrupted row').toBeTruthy();
        expect(resume!.textContent).toContain('Resume');
        expect(discard!.textContent).toContain('Delete');
        resume!.click();
        discard!.click();
        await Promise.resolve();
        expect(onResume).toHaveBeenCalledTimes(1);
        expect(onDiscard).toHaveBeenCalledTimes(1);
    });

    it('non-interrupted phases never render resume/discard', () => {
        for (const phase of ['running', 'uploading', 'splitting', 'preparing', 'queued', 'done', 'cancelled']) {
            const { container, unmount } = render(
                <TransferPanel {...baseProps} splitJobs={[makeJob(phase)]} onResumeSplitJob={() => {}} onDiscardSplitJob={() => {}} />,
            );
            const titles = Array.from(container.querySelectorAll('button')).map(b => b.title);
            expect(titles.some(t => t === 'Resume this split job'), `${phase} must not offer resume`).toBe(false);
            expect(titles.some(t => t.startsWith('Discard this job')), `${phase} must not offer discard`).toBe(false);
            unmount();
        }
    });

    it('handlers are optional — omitting them renders no resume/discard buttons', () => {
        const { container } = render(<TransferPanel {...baseProps} splitJobs={[makeJob('interrupted')]} />);
        const titles = Array.from(container.querySelectorAll('button')).map(b => b.title);
        expect(titles.some(t => t === 'Resume this split job')).toBe(false);
        expect(titles.some(t => t.startsWith('Discard this job'))).toBe(false);
    });
});

describe('selectResumableJobs (startup notice selection)', () => {
    it('selects ONLY interrupted jobs — queued/running/terminal states are not events worth a toast', () => {
        const jobs = [
            { id: 'a', status: 'interrupted' },
            { id: 'b', status: 'queued' },
            { id: 'c', status: 'running' },
            { id: 'd', status: 'done' },
            { id: 'e', status: 'cancelled' },
            { id: 'f', status: 'failed' },
            { id: 'g', status: 'source_missing' },
            { id: 'h', status: 'interrupted' },
        ];
        expect(selectResumableJobs(jobs)).toEqual(['a', 'h']);
    });

    it('empty and no-match inputs yield an empty selection (no toast)', () => {
        expect(selectResumableJobs([])).toEqual([]);
        expect(selectResumableJobs([{ id: 'x', status: 'done' }])).toEqual([]);
    });
});

describe('SplitPartRowView (per-part rows inside expanded group, plan §C)', () => {
    const base = { idx: 2, name: 'Movie.part02.mkv', messageId: null as number | null, sizeBytes: 0 };

    it('uploading part shows live % and Cancel; done part with messageId shows Play+Download', () => {
        // uploading
        const a = render(
            <TransferPanel {...baseProps} splitJobs={[{
                jobId: 'j1', displayName: 'M.mkv', phase: 'uploading', doneParts: 0,
                totalParts: 3, currentPart: '', folderId: null,
                parts: [{ ...base, status: 'uploading', pct: 42, speedBps: 2048 }],
            }]} />,
        );
        void a;
        // Render the row component directly for precise assertions.
        const view = render(
            <SplitPartRowView
                part={{ ...base, status: 'done', messageId: 777, sizeBytes: 52_428_800 }}
                jobPhase="interrupted"
                onPlay={() => {}}
                onDownload={() => {}}
            />,
        );
        expect(view.container.textContent).toContain('50.0 MB'); // sizeBytes as status label (52_428_800 B = 50 MiB)
        unmountAll([a, view]);
    });

    it('cancelled/failed parts offer Retry (Re-include); waiting offers nothing', () => {
        const cancelled = render(<SplitPartRowView part={{ ...base, status: 'cancelled' }} jobPhase="interrupted" onRetry={() => {}} />);
        expect(cancelled.container.querySelector('button[title*="Re-include"]')).toBeTruthy();
        const failed = render(<SplitPartRowView part={{ ...base, status: 'failed' }} jobPhase="interrupted" onRetry={() => {}} />);
        expect(failed.container.querySelector('button[title^="Retry this part"]')).toBeTruthy();
        const waiting = render(<SplitPartRowView part={{ ...base, status: 'waiting' }} jobPhase="running" />);
        expect(waiting.container.querySelectorAll('button').length).toBe(0);
        unmountAll([cancelled, failed, waiting]);
    });

    it('done WITHOUT messageId (edge #10) hides Play and Download even when handlers exist', () => {
        const v = render(
            <SplitPartRowView
                part={{ ...base, status: 'done', messageId: null }}
                jobPhase="interrupted"
                onPlay={() => {}}
                onDownload={() => {}}
            />,
        );
        expect(v.container.querySelector('button[title*="Play"]')).toBeFalsy();
        expect(v.container.querySelector('button[title*="Download"]')).toBeFalsy();
    });
});

function unmountAll(rendered: Array<{ unmount: () => void }>) {
    rendered.forEach(r => r.unmount());
}

describe('parseSplitUploadTid (per-part upload-progress routing, plan §C)', () => {
    it('parses split:<jobId>:<idx> tids', () => {
        expect(parseSplitUploadTid('split:4d97551e4dfda631253019b92e4b5000:2'))
            .toEqual({ jobId: '4d97551e4dfda631253019b92e4b5000', idx: 2 });
    });
    it('rejects non-split tids (they belong to useFileUpload)', () => {
        expect(parseSplitUploadTid('upload-123')).toBeNull();
        expect(parseSplitUploadTid('')).toBeNull();
    });
    it('rejects malformed shapes: zero idx, extra colons, missing parts', () => {
        expect(parseSplitUploadTid('split:abc:0')).toBeNull();
        expect(parseSplitUploadTid('split:a:b:c:1')).toBeNull();
        expect(parseSplitUploadTid('split:abc')).toBeNull();
        expect(parseSplitUploadTid('split:abc:x')).toBeNull();
    });
});

describe('computeCombinedProgress (group header, plan §C/Q17)', () => {
    const mk = (status: string, sizeBytes: number, extra: object = {}) =>
        ({ status, sizeBytes, ...extra });

    it('byte-weighted when all sizes known: done parts count full, live part counts uploadedBytes', () => {
        const r = computeCombinedProgress([
            mk('done', 100),
            mk('uploading', 300, { uploadedBytes: 150, speedBps: 500 }),
            mk('waiting', 100),
        ], 1, 3);
        // done=100 + live=150 → 250/500 = 50%
        expect(r.pct).toBeCloseTo(50);
        expect(r.speedBps).toBe(500);
    });

    it('falls back to done-parts fraction when sizes unknown (edge #11)', () => {
        const r = computeCombinedProgress([mk('done', 0), mk('waiting', 0)], 1, 4);
        expect(r.pct).toBeCloseTo(25);
    });

    it('empty/zero inputs never yield NaN (NaN is the silent killer here)', () => {
        expect(computeCombinedProgress([], 0, 0).pct).toBe(0);
        expect(computeCombinedProgress([mk('waiting', 0)], 0, 1).pct).toBe(0);
        expect(Number.isFinite(computeCombinedProgress([mk('done', -5)], 1, 1).pct)).toBe(true);
    });
});
