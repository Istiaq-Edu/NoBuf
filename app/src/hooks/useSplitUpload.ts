import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

/**
 * SplitUploadModal state machine for the >2GB video split-and-upload flow.
 * Mirrors the backend SplitPlan shape exactly (serde camelCase contract).
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

export function useSplitUpload() {
    const [open, setOpen] = useState(false);
    const [preparing, setPreparing] = useState(false);
    const [plan, setPlan] = useState<SplitPlan | null>(null);
    const [edits, setEdits] = useState<PlanEdits | null>(null);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Set once the job starts; modal shows success then closes. */
    const [startedJobId, setStartedJobId] = useState<string | null>(null);
    const mounted = useRef(true);

    useEffect(() => () => { mounted.current = false; }, []);

    const prepare = useCallback(async (path: string, folderId: number | null) => {
        setOpen(true);
        setPreparing(true);
        setError(null);
        setPlan(null);
        setEdits(null);
        try {
            const p = await invoke<SplitPlan>('cmd_prepare_split', { path, folderId });
            if (!mounted.current) return;
            setPlan(p);
            setEdits({ boundaries: [...p.boundaries] });
        } catch (e) {
            if (mounted.current) setError(typeof e === 'string' ? e : String(e));
        } finally {
            if (mounted.current) setPreparing(false);
        }
    }, []);

    const start = useCallback(async () => {
        if (!plan || !edits) return;
        setStarting(true);
        setError(null);
        try {
            // Send the plan with the user-adjusted boundaries; parts are
            // rebuilt server-side from boundaries (chained-snap preserved).
            const jobId = await invoke<string>('cmd_start_split_job', { plan: { ...plan, boundaries: edits.boundaries } });
            if (!mounted.current) return;
            setStartedJobId(jobId);
            return jobId;
        } catch (e) {
            if (mounted.current) setError(typeof e === 'string' ? e : String(e));
        } finally {
            if (mounted.current) setStarting(false);
        }
    }, [plan, edits]);

    const reset = useCallback(() => {
        setOpen(false);
        setPlan(null);
        setEdits(null);
        setError(null);
        setStartedJobId(null);
    }, []);

    const close = useCallback(() => {
        setOpen(false);
        setStartedJobId(null);
    }, []);

    return { open, preparing, plan, edits, setEdits, starting, startedJobId, error, prepare, start, close, reset };
}
