import { motion } from 'framer-motion';
import { Scissors, FolderOpen, X, HardDriveDownload, Zap } from 'lucide-react';

/**
 * Pre-copy decision for an oversize video that arrived via drag-and-drop.
 *
 * WebView2 gives drops no filesystem path, so splitting a DROPPED video needs
 * one temp copy first. The file-picker path (Upload button) has real paths and
 * splits with zero copying. This dialog makes that tradeoff visible BEFORE any
 * byte is written, and lets the user pick the better lane:
 *   - "Split from temp copy" → proceeds with the staged copy (caller stages).
 *   - "Pick it instead (no copy)" → aborts the drop staging; the Upload
 *     button's native picker takes over — user re-selects the same file there
 *     and gets the zero-copy split flow.
 */

interface OversizeDropChoiceModalProps {
    fileName: string;
    sizeGb: string;
    /** Fired when the user accepts the one-time temp copy. */
    onUseTempCopy: () => void;
    /** Fired when the user prefers the picker path; no bytes are written. */
    onPickInstead: () => void;
    onClose: () => void;
}

export function OversizeDropChoiceModal({
    fileName,
    sizeGb,
    onUseTempCopy,
    onPickInstead,
    onClose,
}: OversizeDropChoiceModalProps) {
    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
            onClick={onClose}
        >
            <motion.div
                initial={{ scale: 0.95, y: 8 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.95, y: 8 }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                className="w-full max-w-md rounded-2xl border border-nobuf-border bg-nobuf-surface shadow-2xl overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-nobuf-border">
                    <div className="flex items-center gap-2 text-nobuf-text font-semibold">
                        <Scissors className="w-4 h-4 text-nobuf-primary" />
                        Split large video
                    </div>
                    <button onClick={onClose} className="text-nobuf-subtext hover:text-nobuf-text transition-colors" aria-label="Close">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="px-5 py-4 space-y-3">
                    <p className="text-sm text-nobuf-text leading-relaxed">
                        <span className="font-semibold break-all">{fileName}</span>{' '}
                        <span className="text-nobuf-subtext">({sizeGb})</span> exceeds your upload limit and will be
                        split into parts. Dropped files arrive without their folder path, so this route needs{' '}
                        <span className="text-amber-400 font-medium">one temporary copy</span> before splitting
                        (auto-deleted when done).
                    </p>

                    {/* Option A: temp copy */}
                    <button
                        onClick={onUseTempCopy}
                        className="w-full flex items-start gap-3 rounded-xl border border-nobuf-border px-4 py-3 text-left hover:border-nobuf-primary/60 hover:bg-white/5 transition-all group"
                    >
                        <HardDriveDownload className="w-5 h-5 mt-0.5 text-nobuf-secondary group-hover:text-nobuf-primary shrink-0" />
                        <span className="block">
                            <span className="block text-sm font-medium text-nobuf-text">Split from a temp copy</span>
                            <span className="block text-xs text-nobuf-subtext mt-0.5">
                                Copy once (~seconds), then split &amp; upload. Nothing to redo.
                            </span>
                        </span>
                    </button>

                    {/* Option B: picker — highlighted as the optimal lane */}
                    <button
                        onClick={onPickInstead}
                        className="w-full flex items-start gap-3 rounded-xl border-2 border-nobuf-primary/70 bg-nobuf-primary/10 px-4 py-3 text-left hover:bg-nobuf-primary/20 transition-all group"
                    >
                        <Zap className="w-5 h-5 mt-0.5 text-nobuf-primary shrink-0" />
                        <span className="block">
                            <span className="block text-sm font-semibold text-nobuf-text">
                                Pick it instead — no copy{' '}
                                <span className="ml-1 align-middle text-[10px] uppercase tracking-wider font-bold text-nobuf-primary border border-nobuf-primary/50 rounded px-1 py-px">
                                    recommended
                                </span>
                            </span>
                            <span className="block text-xs text-nobuf-subtext mt-0.5 flex items-center gap-1">
                                <FolderOpen className="w-3 h-3 inline" />
                                Opens the file picker — select the same file there and split starts directly from
                                the original, zero copying.
                            </span>
                        </span>
                    </button>
                </div>
            </motion.div>
        </motion.div>
    );
}
