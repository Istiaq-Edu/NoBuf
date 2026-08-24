import { useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Scissors, X, Loader2, AlertTriangle, CheckCircle2, Film } from 'lucide-react';
import type { SplitPlan, PlanEdits } from '../../hooks/useSplitUpload';

interface SplitUploadModalProps {
    open: boolean;
    preparing: boolean;
    plan: SplitPlan | null;
    edits: PlanEdits | null;
    starting: boolean;
    startedJobId: string | null;
    error: string | null;
    onClose: () => void;
    onConfirm: () => void;
    onEditBoundaries: (next: number[]) => void;
}

function fmtBytes(n: number): string {
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + ' GB';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(0) + ' MB';
    return (n / 1_000).toFixed(0) + ' KB';
}

function fmtTime(sec: number): string {
    const s = Math.floor(sec % 60);
    const m = Math.floor((sec / 60) % 60);
    const h = Math.floor(sec / 3600);
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const MIN_PART_SECS = 60;

/**
 * WhatsApp-style split screen: filmstrip + draggable cut handles + live
 * parts readout. Presentational + pointer math only; state lives in
 * useSplitUpload (hook) and Dashboard (open/close).
 */
export function SplitUploadModal({
    open, preparing, plan, edits, starting, startedJobId, error, onClose, onConfirm, onEditBoundaries,
}: SplitUploadModalProps) {
    const trackRef = useRef<HTMLDivElement | null>(null);

    const n = edits?.boundaries.length ?? 0;
    const duration = plan?.durationSec ?? 0;

    const pct = (t: number) => (duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0);

    const handlePointerDown = (idx: number) => (e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const track = trackRef.current;
        if (!track || !plan || !edits) return;
        const rect = track.getBoundingClientRect();

        const move = (ev: PointerEvent) => {
            const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
            let t = frac * plan.durationSec;
            // Clamp between neighbours with the 1-minute minimum-part guard.
            const lo = idx === 0 ? MIN_PART_SECS : edits.boundaries[idx - 1] + MIN_PART_SECS;
            const hi = idx === n - 1 ? plan.durationSec - MIN_PART_SECS : edits.boundaries[idx + 1] - MIN_PART_SECS;
            t = Math.min(Math.max(t, lo), hi);
            if (Math.abs(t - edits.boundaries[idx]) < 0.05) return; // skip micro-jitter
            const next = [...edits.boundaries];
            next[idx] = t;
            onEditBoundaries(next);
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };

    // Parts readout derived from CURRENT boundaries — updates while dragging.
    const parts = useMemo(() => {
        if (!plan || !edits) return [];
        const edges = [0, ...edits.boundaries, plan.durationSec];
        const total = edits.boundaries.length + 1;
        const pad = Math.max(2, String(total).length);
        return edges.slice(0, -1).map((s, i) => ({
            name: `${plan.displayName}.part${String(i + 1).padStart(pad, '0')}${plan.partExt}`,
            start: s,
            end: edges[i + 1],
            estBytes: Math.round(plan.sourceSize * ((edges[i + 1] - s) / plan.durationSec)),
        }));
    }, [plan, edits]);

    const tooShort = parts.some(p => p.end - p.start < MIN_PART_SECS);

    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
                    onClick={onClose}
                >
                    <motion.div
                        initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
                        className="bg-nobuf-surface border border-nobuf-border rounded-xl shadow-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between mb-4">
                            <div className="flex items-center gap-2">
                                <Scissors className="w-5 h-5 text-nobuf-primary" />
                                <h3 className="text-lg font-semibold text-nobuf-text">Split Large Video</h3>
                            </div>
                            <button onClick={onClose} className="p-1 hover:bg-nobuf-hover rounded-md transition" title="Close">
                                <X className="w-5 h-5 text-nobuf-subtext" />
                            </button>
                        </div>

                        {preparing && (
                            <div className="flex flex-col items-center justify-center py-12 gap-3">
                                <Loader2 className="w-8 h-8 text-nobuf-primary animate-spin" />
                                <p className="text-sm text-nobuf-subtext">Analyzing video — probing streams, keyframes and filmstrip…</p>
                            </div>
                        )}

                        {!preparing && error && (
                            <div className="flex flex-col items-center justify-center py-10 gap-3">
                                <AlertTriangle className="w-8 h-8 text-red-400" />
                                <p className="text-sm text-nobuf-text text-center px-4">{error}</p>
                                <button onClick={onClose} className="mt-2 px-4 py-2 rounded-lg bg-nobuf-hover text-nobuf-text text-sm hover:brightness-110 transition">
                                    Close
                                </button>
                            </div>
                        )}

                        {!preparing && !error && startedJobId && (
                            <div className="flex flex-col items-center justify-center py-10 gap-3">
                                <CheckCircle2 className="w-8 h-8 text-nobuf-primary" />
                                <p className="text-sm text-nobuf-text">Split job started — check the Transfers panel.</p>
                                <button onClick={onClose} className="mt-2 px-4 py-2 rounded-lg bg-nobuf-primary text-black text-sm font-medium hover:brightness-110 transition">
                                    Done
                                </button>
                            </div>
                        )}

                        {!preparing && !error && plan && edits && !startedJobId && (
                            <>
                                {/* Info line */}
                                <div className="flex items-center gap-2 text-xs text-nobuf-subtext mb-3">
                                    <Film className="w-4 h-4 shrink-0" />
                                    <span className="truncate">{plan.displayName}{plan.partExt} · {fmtBytes(plan.sourceSize)} · {fmtTime(plan.durationSec)}</span>
                                </div>

                                {plan.streamNotice && (
                                    <div className="mb-3 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-xs text-yellow-300">
                                        {plan.streamNotice}
                                    </div>
                                )}

                                {/* Filmstrip + cut handles */}
                                <div className="select-none">
                                    <div
                                        ref={trackRef}
                                        data-split-track
                                        className="relative h-20 rounded-lg overflow-hidden border border-nobuf-border"
                                    >
                                        <div className="absolute inset-0 flex">
                                            {plan.thumbs.length > 0
                                                ? plan.thumbs.map((src, i) => (
                                                    <div key={i} className="flex-1 h-full bg-cover bg-center" style={{ backgroundImage: `url(${src})` }} />
                                                ))
                                                : <div className="flex-1 h-full bg-nobuf-hover" />}
                                        </div>
                                        <div className="absolute inset-0 bg-black/30 pointer-events-none" />

                                        {edits.boundaries.map((b, i) => (
                                            <div
                                                key={i}
                                                data-cut-handle={i}
                                                className="absolute top-0 bottom-0 w-[3px] bg-nobuf-primary cursor-ew-resize touch-none"
                                                style={{ left: `${pct(b)}%`, transform: 'translateX(-50%)' }}
                                                onPointerDown={handlePointerDown(i)}
                                            >
                                                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-nobuf-primary shadow-lg border-2 border-black/40 flex items-center justify-center">
                                                    <Scissors className="w-3 h-3 text-black/70 rotate-90" />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="flex justify-between mt-1 text-[10px] text-nobuf-subtext tabular-nums">
                                        <span>0:00</span>
                                        <span>{fmtTime(duration / 2)}</span>
                                        <span>{fmtTime(duration)}</span>
                                    </div>
                                </div>

                                {/* Parts readout */}
                                <div className="mt-3 space-y-1 max-h-36 overflow-y-auto pr-1">
                                    {parts.map((p, i) => (
                                        <div key={i} className="flex items-center justify-between gap-2 text-xs px-2 py-1 rounded bg-black/20">
                                            <span className="truncate text-nobuf-text">{p.name}</span>
                                            <span className={`tabular-nums shrink-0 ${p.end - p.start < MIN_PART_SECS ? 'text-red-400' : 'text-nobuf-subtext'}`}>
                                                {fmtTime(p.start)} → {fmtTime(p.end)} · ~{fmtBytes(p.estBytes)}
                                            </span>
                                        </div>
                                    ))}
                                </div>

                                {tooShort && (
                                    <p className="mt-2 text-xs text-red-400">Every part must be at least 1 minute.</p>
                                )}

                                {/* Footer */}
                                <div className="flex justify-end gap-2 mt-4">
                                    <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-nobuf-subtext hover:bg-nobuf-hover transition">
                                        Cancel
                                    </button>
                                    <button
                                        onClick={onConfirm}
                                        disabled={starting || tooShort}
                                        className={`px-4 py-2 rounded-lg text-sm font-medium transition flex items-center gap-2 ${
                                            starting || tooShort
                                                ? 'opacity-50 cursor-not-allowed bg-nobuf-hover text-nobuf-subtext'
                                                : 'bg-nobuf-primary text-black hover:brightness-110'
                                        }`}
                                    >
                                        {starting && <Loader2 className="w-4 h-4 animate-spin" />}
                                        {starting ? 'Starting…' : `Split & Upload (${parts.length} parts)`}
                                    </button>
                                </div>
                            </>
                        )}
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
