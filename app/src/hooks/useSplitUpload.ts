import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

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
    useEffect(() => {
        liveRef.current += 1;
        return () => { liveRef.current += 1; };
    }, []);

    const prepare = useCallback(async (path: string, folderId: number | null) => {
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
            const jobId = await invoke<string>('cmd_start_split_job', {
                plan: { ...plan, boundaries: edits.boundaries },
            });
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
        setOpen(false);
        setStartedJobId(null);
    }, []);

    return { open, preparing, plan, edits, setEdits, starting, startedJobId, error, prepare, start, close };
}
