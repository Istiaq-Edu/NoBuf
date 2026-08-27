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

/**
 * Combined group-header progress (plan §C/Q17). Byte-weighted when part sizes
 * are known; falls back to the done-parts fraction when any size is unknown
 * (edge #11). Pure + exported for unit testing.
 */
export function computeCombinedProgress(
    parts: Array<{ status: string; sizeBytes: number; uploadedBytes?: number; pct?: number; speedBps?: number }> | undefined,
    doneParts: number,
    totalParts: number,
): { pct: number; speedBps: number } {
    const list = Array.isArray(parts) ? parts : [];
    if (list.length > 0 && list.every(p => p.sizeBytes > 0)) {
        let done = 0;
        let total = 0;
        let speed = 0;
        for (const p of list) {
            const size = p.sizeBytes;
            total += size;
            speed += p.speedBps ?? 0;
            if (p.status === 'done') done += size;
            else if (typeof p.uploadedBytes === 'number') done += Math.min(p.uploadedBytes, size);
            else if (typeof p.pct === 'number') done += size * Math.min(p.pct, 100) / 100;
        }
        return { pct: total > 0 ? (done / total) * 100 : 0, speedBps: speed };
    }
    // Part-weighted fallback. A live pct must move the group even while all
    // waiting peers are zero-sized placeholders.
    const completed = list.reduce((sum, part) => {
        if (part.status === 'done') return sum + 1;
        if (typeof part.pct === 'number') return sum + Math.max(0, Math.min(100, part.pct)) / 100;
        if (part.sizeBytes > 0 && typeof part.uploadedBytes === 'number') {
            return sum + Math.max(0, Math.min(1, part.uploadedBytes / part.sizeBytes));
        }
        return sum;
    }, 0);
    const pct = totalParts > 0 ? Math.min(100, (Math.max(doneParts, completed) / totalParts) * 100) : 0;
    const speed = list.reduce((s, p) => s + (p.speedBps ?? 0), 0);
    return { pct, speedBps: speed };
}


// ---------------------------------------------------------------------------
// Live split-job rows for the Transfers panel.
// Fed by the backend `split-progress` events; initial state comes from the DB
// via cmd_list_split_jobs so rows survive app restarts.
// ---------------------------------------------------------------------------

/** Per-part live state for the expanded group view (parts-first §C). */
export interface SplitPartRow {
    idx: number;
    name: string;
    status: string;
    messageId: number | null;
    sizeBytes: number;
    /** 0-100, live from upload-progress events (undefined = not yet uploading). */
    pct?: number;
    /** bytes/sec, live. */
    speedBps?: number;
    uploadedBytes?: number;
}

export interface SplitJobRow {
    jobId: string;
    displayName: string;
    /** 'queued' | 'splitting' | 'uploading' | 'done' | 'interrupted' | 'cancelled' */
    phase: string;
    doneParts: number;
    totalParts: number;
    currentPart: string;
    folderId: number | null;
    parts: SplitPartRow[];
}

/** Count each active split job once for the Transfers badge. */
export function countActiveSplitJobs(jobs: Array<{ phase: string }> | undefined): number {
    return (jobs ?? []).filter(j => ['queued', 'running', 'splitting', 'uploading'].includes(j.phase)).length;
}

export interface SplitUploadProgressPayload {
    id: string;
    percent: number;
    uploaded_bytes?: number;
    total_bytes?: number;
    speed_bytes_per_sec?: number;
    uploadedBytes?: number;
    totalBytes?: number;
    speedBytesPerSec?: number;
}

export function normalizeSplitUploadProgress(payload: SplitUploadProgressPayload) {
    return {
        uploadedBytes: payload.uploaded_bytes ?? payload.uploadedBytes ?? 0,
        totalBytes: payload.total_bytes ?? payload.totalBytes ?? 0,
        speedBps: payload.speed_bytes_per_sec ?? payload.speedBytesPerSec ?? 0,
    };
}

/** Module-level store so multiple hook instances share one source of truth. */
const splitRows = new Map<string, SplitJobRow>();
const splitRowListeners = new Set<() => void>();
let progressListenerAttached = false;
let uploadProgressListenerAttached = false;
/** Startup resume notice fires ONCE per webview lifetime, not per remount
 *  (StrictMode dev double-mounts would otherwise toast twice). */
let startupNoticeFired = false;

function notifySplitRows() {
    splitRowListeners.forEach(l => l());
}

/** Remove a job's row entirely (Discard/Delete) so it leaves the panel at once. */
export function removeSplitRow(jobId: string) {
    splitRows.delete(jobId);
    notifySplitRows();
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
        folderId: row.folderId ?? prev?.folderId ?? null,
        parts: row.parts ?? prev?.parts ?? [],
    });
    notifySplitRows();
}

export function splitPlanToQueuedRow(jobId: string, plan: SplitPlan): SplitJobRow {
    const totalDuration = plan.durationSec > 0 ? plan.durationSec : 1;
    return {
        jobId,
        displayName: plan.displayName,
        phase: 'queued',
        doneParts: 0,
        totalParts: plan.parts.length,
        currentPart: 'Waiting for the upload lane',
        folderId: plan.folderId,
        parts: plan.parts.map(part => ({
            idx: part.idx,
            name: part.name,
            status: 'waiting',
            messageId: null,
            sizeBytes: Math.round(plan.sourceSize * ((part.endSec - part.startSec) / totalDuration)),
        })),
    };
}

function registerStartedSplitJob(jobId: string, plan: SplitPlan) {
    const queued = splitPlanToQueuedRow(jobId, plan);
    const prev = splitRows.get(jobId);
    if (!prev) {
        upsertSplitRow(queued);
        return;
    }
    const liveParts = new Map(prev.parts.map(part => [part.idx, part]));
    upsertSplitRow({
        jobId,
        displayName: queued.displayName,
        folderId: queued.folderId,
        totalParts: Math.max(prev.totalParts, queued.totalParts),
        parts: queued.parts.map(part => ({ ...part, ...liveParts.get(part.idx) })),
    });
}

/**
 * Pure tid matcher for split per-part upload-progress events (plan §C).
 * `split:<jobId>:<idx>` — jobId is a 32-hex string so it can contain no ':'.
 * Exported + unit-tested (mutation-checked) per nobuf-vitest-testing rules.
 */
export function parseSplitUploadTid(tid: string): { jobId: string; idx: number } | null {
    const m = /^split:(.+):(\d+)$/.exec(tid);
    if (!m || m[1].includes(':')) return null;
    const idx = Number(m[2]);
    return idx > 0 ? { jobId: m[1], idx } : null;
}

/**
 * Pure part-reducer for split-progress events (extracted for unit tests).
 * `phaseTerminal` guards the name-fill: terminal-phase events carry the job's
 * ERROR text in `message` with `partIdx: doneCount` — without the guard that
 * error string becomes a part's filename (update_status emit, split_upload.rs
 * §update_status). Exported + mutation-tested per nobuf-vitest-testing rules.
 */
export function applySplitProgressToParts(
    parts: SplitPartRow[],
    p: { phase: string; partIdx: number; message: string; partStatus?: string | null; messageId?: number | null },
): SplitPartRow[] {
    // Live phase marks the CURRENT part splitting/uploading. Transitions:
    // waiting → splitting → uploading → (terminal via partStatus). A part
    // stuck on an earlier transient must still advance when the phase moves
    // on (the "frozen at splitting" bug: only-upgrade-from-waiting locked
    // the label forever once splitting had been seen).
    const liveIdx = p.partIdx > 0 ? p.partIdx : 0;
    const phaseTerminal = p.phase === 'done' || p.phase === 'failed' || p.phase === 'interrupted'
        || p.phase === 'cancelled' || p.phase === 'source_missing';
    return parts.map(part => {
        const next = { ...part };
        if (p.partStatus && part.idx === p.partIdx) {
            next.status = p.partStatus; // authoritative terminal flip
            // Terminal/retry flips invalidate live byte progress: a cancelled
            // part's abandoned bytes must stop contributing to the aggregate,
            // and a retried part starts fresh (its next 0% event must not be
            // "backward" against stale counters). `done` keeps sizeBytes and
            // GAINS the message id for live Play/Download.
            if (p.partStatus === 'done') {
                next.messageId = p.messageId ?? null;
                next.pct = undefined;
                next.uploadedBytes = undefined;
                next.speedBps = undefined;
            } else if (p.partStatus === 'cancelled' || p.partStatus === 'failed' || p.partStatus === 'waiting') {
                next.messageId = null;
                next.pct = undefined;
                next.uploadedBytes = undefined;
                next.speedBps = undefined;
            }
        } else if (!p.partStatus && part.idx === liveIdx) {
            if ((part.status === 'waiting' || part.status === 'splitting') && p.phase === 'splitting') {
                next.status = 'splitting';
            } else if ((part.status === 'waiting' || part.status === 'splitting') && p.phase === 'uploading') {
                next.status = 'uploading';
            }
        }
        if (part.idx === liveIdx && !next.name && p.message && !phaseTerminal) next.name = p.message;
        return next;
    });
}

function applySplitProgress(p: {
    jobId: string; phase: string; partIdx: number; totalParts: number;
    message: string; partStatus?: string | null; messageId?: number | null;
}) {
    const prev = splitRows.get(p.jobId);
    // Synthesize placeholder part rows from totalParts if hydration never
    // populated them (job started THIS session — hydration only runs once).
    let parts = prev?.parts ?? [];
    if (parts.length === 0 && p.totalParts > 0) {
        parts = Array.from({ length: p.totalParts }, (_, i) => ({
            idx: i + 1,
            name: '',
            status: 'waiting',
            messageId: null as number | null,
            sizeBytes: 0,
        }));
    }
    parts = applySplitProgressToParts(parts, p);
    // Recompute doneParts from actual part statuses when we have them —
    // partIdx is an IN-PROGRESS index during splitting, not a count
    // (investigator-verified misread in the old code).
    const doneCount = parts.length > 0
        ? parts.filter(x => x.status === 'done').length
        : undefined;
    upsertSplitRow({
        jobId: p.jobId,
        phase: p.phase,
        totalParts: p.totalParts || prev?.totalParts || 0,
        currentPart: p.message,
        doneParts: doneCount,
        parts,
        displayName: prev?.displayName,
    });
}

/** Attach ONE Tauri event listener pair for the lifetime of the webview. */
async function ensureProgressListener() {
    try {
        const { listen } = await import('@tauri-apps/api/event');
        if (!progressListenerAttached) {
            progressListenerAttached = true;
            await listen<{
                jobId: string; phase: string; partIdx: number; totalParts: number;
                message: string; partStatus?: string | null; messageId?: number | null;
            }>('split-progress', (ev) => applySplitProgress(ev.payload));
        }
        if (!uploadProgressListenerAttached) {
            uploadProgressListenerAttached = true;
            // Byte-level per-part progress ALREADY FLOWS under split:<job>:<idx>
            // tids (fs.rs emits them for every upload with a tid); nothing
            // consumed them before this listener existed (plan seam #a).
            await listen<SplitUploadProgressPayload>('upload-progress', (ev) => {
                const payload = ev.payload;
                const parsed = parseSplitUploadTid(payload.id);
                if (!parsed) return; // non-split uploads belong to useFileUpload
                const job = splitRows.get(parsed.jobId);
                if (!job) return;
                const { uploadedBytes, totalBytes, speedBps } = normalizeSplitUploadProgress(payload);
                upsertSplitRow({
                    jobId: parsed.jobId,
                    parts: job.parts.map(part =>
                        part.idx === parsed.idx
                            ? {
                                ...part,
                                sizeBytes: totalBytes > 0 ? totalBytes : part.sizeBytes,
                                pct: payload.percent,
                                speedBps,
                                uploadedBytes,
                            }
                            : part,
                    ),
                });
            });
        }
    } catch (e) {
        console.warn('[split-rows] listener attach failed', e);
        progressListenerAttached = false;
        uploadProgressListenerAttached = false;
    }
}

/**
 * Backoff schedule for split-rows hydration retries (WP5: a single transient
 * DB lock at startup must not leave the Transfers panel permanently empty).
 * Pure + exported for unit tests.
 */
export function hydrationRetryDelaysMs(): number[] {
    return [1500, 6000, 15000];
}

/**
 * Pure decision for whether hydration needs another attempt after a failure.
 * Bounded: after the last delay, hydration gives up and surfaces an error
 * toast (the panel stays empty but the user knows WHY, and job rows still
 * appear via live `split-progress` events).
 */
export function shouldRetryHydration(attempt: number): boolean {
    const delays = hydrationRetryDelaysMs();
    return attempt < delays.length;
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
            registerStartedSplitJob(jobId, plan);
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
        // Hydration from the jobs DB (survives restarts). Retries with
        // backoff on failure — a transient DB lock at startup must not
        // leave the Transfers panel empty for the whole session. Gives up
        // after the last attempt and tells the user why (live progress
        // events still populate rows for jobs that emit while we run).
        let cancelled = false;
        let attempt = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const hydrate = async () => {
            try {
                const jobs = await invoke<Array<{
                    id: string; displayName: string; status: string;
                    totalParts: number; doneParts: number; error?: string | null;
                    folderId?: number | null;
                    parts?: Array<{ idx: number; name: string; status: string; messageId: number | null; sizeBytes: number }>;
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
                        folderId: j.folderId ?? null,
                        parts: (j.parts ?? []).map(p => ({ ...p })),
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
            } catch {
                if (cancelled) return;
                if (shouldRetryHydration(attempt)) {
                    timer = setTimeout(hydrate, hydrationRetryDelaysMs()[attempt]);
                    attempt += 1;
                } else {
                    toast.error('Couldn\'t load split uploads. Restart the app if your jobs are missing from Transfers.');
                }
            }
        };
        void hydrate();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
            splitRowListeners.delete(listener);
        };
    }, []);

    const splitJobRows: SplitJobRow[] = Array.from(splitRows.values());

    return { open, preparing, plan, edits, setEdits, starting, startedJobId, error, phase, splitJobRows, prepare, start, close };
}
