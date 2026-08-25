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
import { TransferPanel } from '../components/dashboard/TransferPanel';
import { selectResumableJobs } from '../hooks/useSplitUpload';

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
        const resume = buttons.find(b => b.title === 'Resume this split job');
        const discard = buttons.find(b => b.title === 'Discard this job — deletes finished parts and temp data');
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
