import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';

/**
 * SplitUploadModal state machine for the >2GB video split-and-upload flow.
 * Mirrors the backend SplitPlan shape exactly (serde camelCase contract).
 *
 * StrictMode note: React 18 dev double-mounts components. A naive
 * `mounted.current = false` cleanup permanently disarms the guard after the
 * simulated unmount. Instead each effect run claims a fresh mount token and
 * async results only apply when the token still matches.
 */

export interface SplitPartPlan {
    idx: number;
    name: string;
    startSec: number;
    endSec: number;
}

export interface SplitPlan {
    sourcePath: string;
    sourceSize: number;
    displayName: string;
    folderId: number | null;
    capBytes: number;
    durationSec: number;
    container: string;
    partExt: string;
    mapAll: boolean;
    streamNotice: string | null;
    boundaries: number[];
    parts: SplitPartPlan[];
    thumbs: string[];
}

/** Editable copy of the plan while the user drags handles. */
export interface PlanEdits {
    boundaries: number[];
}

function errText(e: unknown): string {
    return typeof e === 'string' ? e : String(e);
}

/**
 * Phase E: which freshly-loaded split jobs deserve a startup resume notice.
 * Only 'interrupted' rows count — a crash/power-loss left finished parts on
 * disk and Telegram, and the user must be told resume is one click away.
 * Deliberately excludes 'queued' (normal queue state, not an event) and
 * terminal statuses. Pure + exported so the selection is unit-tested without
 * Tauri (nobuf-vitest-testing pure-helper pattern).
 */
export function selectResumableJobs(jobs: Array<{ id: string; status: string }>): string[] {
    return jobs.filter(j => j.status === 'interrupted').map(j => j.id);
}


// ---------------------------------------------------------------------------
// Live split-job rows for the Transfers panel.
// Fed by the backend `split-progress` events; initial state comes from the DB
// via cmd_list_split_jobs so rows survive app restarts.
// ---------------------------------------------------------------------------

export interface SplitJobRow {
    jobId: string;
    displayName: string;
    /** 'queued' | 'splitting' | 'uploading' | 'done' | 'interrupted' | 'cancelled' */
    phase: string;
    doneParts: number;
    totalParts: number;
    currentPart: string;
}

/** Module-level store so multiple hook instances share one source of truth. */
const splitRows = new Map<string, SplitJobRow>();
const splitRowListeners = new Set<() => void>();
let progressListenerAttached = false;
/** Startup resume notice fires ONCE per webview lifetime, not per remount
 *  (StrictMode dev double-mounts would otherwise toast twice). */
let startupNoticeFired = false;

function notifySplitRows() {
    splitRowListeners.forEach(l => l());
}

function upsertSplitRow(row: Partial<SplitJobRow> & { jobId: string }) {
    const prev = splitRows.get(row.jobId);
    splitRows.set(row.jobId, {
        jobId: row.jobId,
        displayName: row.displayName ?? prev?.displayName ?? 'Split upload',
        phase: row.phase ?? prev?.phase ?? 'queued',
        doneParts: row.doneParts ?? prev?.doneParts ?? 0,
        totalParts: row.totalParts ?? prev?.totalParts ?? 0,
        currentPart: row.currentPart ?? prev?.currentPart ?? '',
    });
    notifySplitRows();
}

/** Attach ONE Tauri event listener for the lifetime of the webview. */
async function ensureProgressListener() {
    if (progressListenerAttached) return;
    progressListenerAttached = true;
    try {
        const { listen } = await import('@tauri-apps/api/event');
        await listen<{ jobId: string; phase: string; partIdx: number; totalParts: number; message: string }>(
            'split-progress',
            (ev) => {
                const p = ev.payload;
                const prev = splitRows.get(p.jobId);
                upsertSplitRow({
                    jobId: p.jobId,
                    phase: p.phase,
                    doneParts: p.partIdx,
                    totalParts: p.totalParts,
                    currentPart: p.message,
                    // display name survives via prev
                    displayName: prev?.displayName,
                });
            },
        );
    } catch (e) {
        console.warn('[split-rows] listener attach failed', e);
        progressListenerAttached = false;
    }
}

export function useSplitUpload() {
    const [open, setOpen] = useState(false);
    const [preparing, setPreparing] = useState(false);
    const [plan, setPlan] = useState<SplitPlan | null>(null);
    const [edits, setEdits] = useState<PlanEdits | null>(null);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Set once the job starts; modal shows success then closes. */
    const [startedJobId, setStartedJobId] = useState<string | null>(null);

    // Liveness token — bumped on every remount; stale async results are dropped.
    const liveRef = useRef(0);
    // Path of the %TEMP% copy created when an oversize video arrived via drag-
    // and-drop (picker sources are real user files). Deleted if the user closes
    // the modal without starting; Rust owns deletion once the job starts.
    const stagedSourceRef = useRef<string | null>(null);
    // Flips true the moment cmd_start_split_job is invoked from this session.
    const jobStartedRef = useRef(false);
    useEffect(() => {
        liveRef.current += 1;
        return () => { liveRef.current += 1; };
    }, []);

    const prepare = useCallback(async (path: string, folderId: number | null) => {
        stagedSourceRef.current = path;
        // New session: nothing has been handed to Rust yet, so closing this
        // modal must clean up THIS session's staged copy (if any).
        jobStartedRef.current = false;
        const live = liveRef.current;
        setOpen(true);
        setPreparing(true);
        setError(null);
        setPlan(null);
        setEdits(null);
        try {
            const p = await invoke<SplitPlan>('cmd_prepare_split', { path, folderId });
            if (liveRef.current !== live) return;
            setPlan(p);
            // Deep-copy so modal edits never mutate the server-side plan copy.
            setEdits({ boundaries: [...p.boundaries] });
        } catch (e) {
            if (liveRef.current !== live) return;
            setError(errText(e));
        } finally {
            if (liveRef.current === live) setPreparing(false);
        }
    }, []);

    const start = useCallback(async (): Promise<string | undefined> => {
        if (!plan || !edits) return undefined;
        const live = liveRef.current;
        setStarting(true);
        setError(null);
        try {
            // Send the plan with user-adjusted boundaries; parts are rebuilt
            // server-side from boundaries (chained-snap preserved).
            // NOTE: flipped only AFTER invoke resolves — if the start fails
            // (disk reject, network flap), close() must still delete this
            // session's staged copy because no job owns it.
            const jobId = await invoke<string>('cmd_start_split_job', {
                plan: { ...plan, boundaries: edits.boundaries },
            });
            jobStartedRef.current = true;
            if (liveRef.current !== live) return undefined;
            setStartedJobId(jobId);
            return jobId;
        } catch (e) {
            if (liveRef.current !== live) return undefined;
            setError(errText(e));
            return undefined;
        } finally {
            if (liveRef.current === live) setStarting(false);
        }
    }, [plan, edits]);

    /** Modal closed via X/Cancel/Done. Clears transient success state. */
    const close = useCallback(() => {
        if (!jobStartedRef.current && stagedSourceRef.current) {
            invoke('cmd_delete_staged_file', { path: stagedSourceRef.current }).catch(() => {});
            stagedSourceRef.current = null;
        }
        setOpen(false);
        setStartedJobId(null);
    }, []);

    // Coarse lifecycle for outside observers (e.g. auto-opening the Transfers
    // panel while an oversize drop is staging/splitting).
    const phase: 'idle' | 'preparing' | 'ready' | 'running' =
        open ? (startedJobId ? 'running' : plan ? 'ready' : 'preparing') : 'idle';
    // Subscribe this component to the shared split-row store and hydrate once.
    const [, forceTick] = useState(0);
    useEffect(() => {
        void ensureProgressListener();
        const listener = () => forceTick(t => t + 1);
        splitRowListeners.add(listener);
        // One-time hydration from the jobs DB (survives restarts).
        (async () => {
            try {
                const jobs = await invoke<Array<{
                    id: string; displayName: string; status: string;
                    totalParts: number; doneParts: number; error?: string | null;
                }>>('cmd_list_split_jobs');
                for (const j of jobs) {
                    if (j.status === 'done' || j.status === 'cancelled') continue;
                    upsertSplitRow({
                        jobId: j.id,
                        displayName: j.displayName,
                        phase: j.status,
                        doneParts: j.doneParts ?? 0,
                        totalParts: j.totalParts ?? 0,
                        currentPart: j.error ?? '',
                    });
                }
                notifySplitRows();
                // Phase E startup notice: interrupted jobs mean a crash or
                // power loss left finished parts behind — tell the user resume
                // is one click away in the Transfers panel. Once per webview
                // (StrictMode remounts must not re-toast).
                if (!startupNoticeFired) {
                    startupNoticeFired = true;
                    const resumable = selectResumableJobs(jobs);
                    console.info(`[SPLIT] startup resume notice: ${resumable.length} interrupted job(s)`);
                if (resumable.length === 1) {
                    const job = jobs.find(j => j.id === resumable[0]);
                    toast.info(`"${job?.displayName ?? 'Split upload'}" didn't finish — open Transfers to resume it.`, {
                        description: `${job?.doneParts ?? 0} of ${job?.totalParts ?? '?'} parts already uploaded.`,
                    });
                } else if (resumable.length > 1) {
                    toast.info(`${resumable.length} split uploads didn't finish — open Transfers to resume them.`, {
                        description: 'Each kept every part uploaded so far.',
                    });
                }
                }
            } catch { /* panel just stays empty */ }
        })();
        return () => { splitRowListeners.delete(listener); };
    }, []);

    const splitJobRows: SplitJobRow[] = Array.from(splitRows.values());

    return { open, preparing, plan, edits, setEdits, starting, startedJobId, error, phase, splitJobRows, prepare, start, close };
}
