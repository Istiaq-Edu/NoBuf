import { useState } from 'react';
import { Upload, Download, X, RotateCcw, AlertCircle, Check, Scissors, ChevronDown, ChevronRight, Play } from 'lucide-react';
import { QueueItem, DownloadItem } from '../../types';
import { SplitJobRow, SplitPartRow, computeCombinedProgress, countActiveSplitJobs } from '../../hooks/useSplitUpload';

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatSpeed(bps?: number): string {
    if (!bps || bps <= 0) return '';
    return `${formatBytes(bps)}/s`;
}

type Tab = 'uploads' | 'downloads';

interface TransferPanelProps {
    isOpen: boolean;
    onClose: () => void;
    // Upload props
    uploadItems: QueueItem[];
    stagingItems?: { name: string; pct: number }[];
    splitJobs?: SplitJobRow[];
    onCancelSplitJob?: (jobId: string) => void;
    onResumeSplitJob?: (jobId: string) => void;
    onDiscardSplitJob?: (jobId: string) => void;
    onClearFinishedSplitJobs?: () => void;
    onCancelSplitPart?: (jobId: string, idx: number) => void;
    onRetrySplitPart?: (jobId: string, idx: number) => void;
    onPlaySplitPart?: (jobId: string, idx: number) => void;
    onDownloadSplitPart?: (jobId: string, idx: number) => void;
    onCancelStaging?: (name: string) => void;
    onClearUploadFinished: () => void;
    onCancelAllUploads: () => void;
    onCancelUploadItem: (id: string) => void;
    onRetryUploadItem: (id: string) => void;
    onDeleteUploadItem?: (id: string) => void;
    // Download props
    downloadItems: DownloadItem[];
    onClearDownloadFinished: () => void;
    onCancelAllDownloads: () => void;
    onCancelDownloadItem: (id: string) => void;
    onRetryDownloadItem: (id: string) => void;
}

export function TransferPanel({
    isOpen, onClose,
    uploadItems, stagingItems = [], splitJobs = [], onCancelSplitJob, onResumeSplitJob, onDiscardSplitJob, onClearFinishedSplitJobs, onCancelSplitPart, onRetrySplitPart, onPlaySplitPart, onDownloadSplitPart, onCancelStaging, onClearUploadFinished, onCancelAllUploads, onCancelUploadItem, onRetryUploadItem, onDeleteUploadItem,
    downloadItems, onClearDownloadFinished, onCancelAllDownloads, onCancelDownloadItem, onRetryDownloadItem,
}: TransferPanelProps) {
    const [activeTab, setActiveTab] = useState<Tab>('uploads');
    /** Expanded split-group jobIds (per-part rows visible). */
    const [expandedJobIds, setExpandedJobIds] = useState<Set<string>>(new Set());
    const toggleExpanded = (jobId: string) => {
        setExpandedJobIds(prev => {
            const next = new Set(prev);
            if (next.has(jobId)) next.delete(jobId); else next.add(jobId);
            return next;
        });
    };

    const uploadActive = uploadItems.filter(i => i.status === 'pending' || i.status === 'uploading').length
        + stagingItems.length + countActiveSplitJobs(splitJobs);
    const downloadActive = downloadItems.filter(i => i.status === 'pending' || i.status === 'downloading').length;

    // Auto-switch to tab with active items
    const effectiveTab = activeTab;

    const items = effectiveTab === 'uploads' ? uploadItems : downloadItems;
    const hasPendingOrActive = effectiveTab === 'uploads'
        ? uploadItems.some(i => i.status === 'pending' || i.status === 'uploading')
        : downloadItems.some(i => i.status === 'pending' || i.status === 'downloading');
    const hasFinished = effectiveTab === 'uploads'
        ? uploadItems.some(i => i.status === 'success' || i.status === 'error' || i.status === 'cancelled') || splitJobs.some(j => j.phase === 'done')
        : downloadItems.some(i => i.status === 'success' || i.status === 'error' || i.status === 'cancelled');

    return (
        <>
            {/* Backdrop for click-outside-to-close */}
            {isOpen && (
                <div
                    className="fixed inset-0 z-30"
                    onClick={onClose}
                />
            )}
            <div
                className={`fixed right-0 top-14 bottom-0 w-full sm:w-[380px] bg-nobuf-surface border-l border-nobuf-border shadow-2xl z-40 flex flex-col transition-transform duration-300 ease-in-out ${
                    isOpen ? 'translate-x-0' : 'translate-x-full'
                }`}
            >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-nobuf-border bg-nobuf-hover/50">
                <h3 className="text-sm font-semibold text-nobuf-text">Transfers</h3>
                <button
                    onClick={onClose}
                    className="p-1 hover:bg-nobuf-border rounded text-nobuf-subtext hover:text-nobuf-text transition-colors"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-nobuf-border">
                <button
                    onClick={() => setActiveTab('uploads')}
                    className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-medium transition-colors relative ${
                        effectiveTab === 'uploads'
                            ? 'text-nobuf-primary'
                            : 'text-nobuf-subtext hover:text-nobuf-text'
                    }`}
                >
                    <Upload className="w-3.5 h-3.5" />
                    Uploads
                    {uploadActive > 0 && (
                        <span className="px-1.5 py-0.5 bg-nobuf-ocean-green/20 text-nobuf-ocean-green rounded-full text-[10px]">
                            {uploadActive}
                        </span>
                    )}
                    {effectiveTab === 'uploads' && (
                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-nobuf-primary" />
                    )}
                </button>
                <button
                    onClick={() => setActiveTab('downloads')}
                    className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-medium transition-colors relative ${
                        effectiveTab === 'downloads'
                            ? 'text-nobuf-primary'
                            : 'text-nobuf-subtext hover:text-nobuf-text'
                    }`}
                >
                    <Download className="w-3.5 h-3.5" />
                    Downloads
                    {downloadActive > 0 && (
                        <span className="px-1.5 py-0.5 bg-nobuf-secondary/20 text-nobuf-secondary rounded-full text-[10px]">
                            {downloadActive}
                        </span>
                    )}
                    {effectiveTab === 'downloads' && (
                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-nobuf-primary" />
                    )}
                </button>
            </div>

            {/* Actions bar */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-nobuf-border/50">
                <span className="text-[11px] text-nobuf-subtext">
                    {items.length} {items.length === 1 ? 'item' : 'items'}
                </span>
                <div className="flex gap-2">
                    {hasPendingOrActive && (
                        <button
                            onClick={effectiveTab === 'uploads' ? onCancelAllUploads : onCancelAllDownloads}
                            className="text-[11px] text-red-400 hover:text-red-300 transition-colors"
                        >
                            Cancel All
                        </button>
                    )}
                    {hasFinished && (
                        <button
                            onClick={effectiveTab === 'uploads' ? () => { onClearUploadFinished(); onClearFinishedSplitJobs?.(); } : onClearDownloadFinished}
                            className="text-[11px] text-nobuf-primary hover:text-nobuf-text transition-colors"
                        >
                            Clear Finished
                        </button>
                    )}
                </div>
            </div>

            {/* Items list */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {/* Split-job GROUP rows: collapsible header (combined % + speed) expanding
                    to per-part rows with per-part actions (parts-first plan §C). */}
                {effectiveTab === 'uploads' && splitJobs.map(j => {
                    const active = j.phase === 'running' || j.phase === 'splitting' || j.phase === 'uploading';
                    const combined = computeCombinedProgress(j.parts, j.doneParts, j.totalParts);
                    const pctNum = Math.round(combined.pct);
                    const expanded = expandedJobIds.has(j.jobId);
                    const hasPartRows = (j.parts?.length ?? 0) > 0;
                    const phaseLabel =
                        j.phase === 'queued' ? 'queued — waiting for current split to finish'
                        : j.phase === 'splitting' ? `splitting part ${Math.min(j.doneParts + 1, j.totalParts || 1)}/${j.totalParts}`
                        : j.phase === 'uploading' ? `uploading — ${j.doneParts}/${j.totalParts} done (${pctNum}%)`
                        : j.phase === 'interrupted' ? 'paused — resume or retry parts below'
                        : j.phase === 'cancelled' ? 'cancelled'
                        : j.phase;
                    return (
                        <div key={j.jobId} className={`flex flex-col gap-1 p-2.5 rounded-lg ${active ? 'bg-nobuf-primary/10 border border-nobuf-primary/30' : 'bg-nobuf-hover'}`}>
                            <div className="flex items-center gap-3 text-sm">
                                <button
                                    className="flex-shrink-0 disabled:opacity-40"
                                    disabled={!hasPartRows}
                                    onClick={() => toggleExpanded(j.jobId)}
                                    title={expanded ? 'Hide individual parts' : 'Show individual parts'}
                                >
                                    {hasPartRows && expanded
                                        ? <ChevronDown className="w-4 h-4 text-nobuf-subtext" />
                                        : hasPartRows
                                            ? <ChevronRight className="w-4 h-4 text-nobuf-subtext" />
                                            : <StatusDot phase={j.phase} />}
                                </button>
                                <div className="flex-1 min-w-0">
                                    <div className="text-nobuf-text text-xs truncate break-all leading-snug flex items-center gap-1.5">
                                        <Scissors className="w-3 h-3 text-nobuf-primary shrink-0" />
                                        <span className="truncate">{j.displayName}</span>
                                        <span className="text-[9px] uppercase tracking-wide font-semibold px-1 py-px rounded bg-black/30 text-nobuf-subtext shrink-0">split</span>
                                    </div>
                                    <div className="text-[10px] text-nobuf-subtext mt-0.5 truncate flex items-center gap-2">
                                        <span>{phaseLabel}</span>
                                        {active && combined.speedBps > 0 && (
                                            <span className="text-nobuf-primary">{formatSpeed(combined.speedBps)}</span>
                                        )}
                                    </div>
                                </div>
                                {onCancelSplitJob && active && (
                                    <button
                                        onClick={() => onCancelSplitJob(j.jobId)}
                                        className="text-gray-400 hover:text-red-400 transition-colors flex-shrink-0"
                                        title="Cancel this split job"
                                    >
                                        <X className="w-3.5 h-3.5" />
                                    </button>
                                )}
                                {j.phase === 'interrupted' && (onResumeSplitJob || onDiscardSplitJob) && (
                                    <div className="flex items-center gap-1.5 flex-shrink-0">
                                        {onResumeSplitJob && (
                                            <button
                                                onClick={() => onResumeSplitJob(j.jobId)}
                                                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-nobuf-primary/15 text-nobuf-primary hover:bg-nobuf-primary/25 transition-colors"
                                                title="Resume this split job (skips parts you cancelled)"
                                            >
                                                <RotateCcw className="w-3 h-3" />
                                                Resume
                                            </button>
                                        )}
                                        {onDiscardSplitJob && (
                                            <button
                                                onClick={() => onDiscardSplitJob(j.jobId)}
                                                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-red-500/10 text-red-400/80 hover:bg-red-500/20 hover:text-red-400 transition-colors"
                                                title="Discard this job — deletes the job record and temp files"
                                            >
                                                <X className="w-3 h-3" />
                                                Delete
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                            {j.totalParts > 0 && (
                                <div className="w-full bg-nobuf-border h-1 mt-1 rounded-full overflow-hidden">
                                    <div
                                        className={`h-full rounded-full transition-all duration-300 ${j.phase === 'interrupted' ? 'bg-orange-400' : 'bg-nobuf-primary'}`}
                                        style={{ width: `${pctNum}%` }}
                                    />
                                </div>
                            )}
                            {expanded && hasPartRows && j.parts.map(part => (
                                <SplitPartRowView
                                    key={`${j.jobId}-${part.idx}`}
                                    jobPhase={j.phase}
                                    part={part}
                                    onCancel={onCancelSplitPart ? () => onCancelSplitPart(j.jobId, part.idx) : undefined}
                                    onRetry={onRetrySplitPart ? () => onRetrySplitPart(j.jobId, part.idx) : undefined}
                                    onPlay={onPlaySplitPart ? () => onPlaySplitPart(j.jobId, part.idx) : undefined}
                                    onDownload={onDownloadSplitPart ? () => onDownloadSplitPart(j.jobId, part.idx) : undefined}
                                />
                            ))}
                        </div>
                    );
                })}
                {effectiveTab === 'uploads' && stagingItems.map(s => (
                    <div key={s.name} className="flex flex-col gap-1 p-2.5 bg-nobuf-hover rounded-lg">
                        <div className="flex items-center gap-3 text-sm">
                            <div className="w-4 h-4 flex-shrink-0 rounded-full border-2 border-nobuf-primary border-t-transparent animate-spin" />
                            <div className="flex-1 text-nobuf-subtext text-xs line-clamp-2 break-all leading-snug">{s.name}</div>
                            <span className="text-[10px] text-nobuf-subtext flex-shrink-0">preparing…</span>
                            {onCancelStaging && (
                                <button
                                    onClick={() => onCancelStaging(s.name)}
                                    className="text-gray-400 hover:text-red-400 transition-colors flex-shrink-0"
                                    title="Stop preparing this file"
                                >
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            )}
                        </div>
                        <div className="w-full bg-nobuf-border h-1 mt-1 rounded-full overflow-hidden">
                            <div
                                className="h-full rounded-full bg-nobuf-primary transition-all duration-300"
                                style={{ width: `${s.pct}%` }}
                            />
                        </div>
                    </div>
                ))}
                {items.length === 0 && stagingItems.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-nobuf-subtext">
                        {effectiveTab === 'uploads' ? (
                            <Upload className="w-8 h-8 mb-2 opacity-30" />
                        ) : (
                            <Download className="w-8 h-8 mb-2 opacity-30" />
                        )}
                        <span className="text-xs">No {effectiveTab} yet</span>
                    </div>
                ) : (
                    items.map(item => (
                        <div key={item.id} className="flex flex-col gap-1 p-2.5 bg-nobuf-hover rounded-lg">
                            <div className="flex items-center gap-3 text-sm">
                                {/* Status icon */}
                                <div className="flex-shrink-0">
                                    {item.status === 'pending' && (
                                        <div className={`w-4 h-4 rounded-full ${effectiveTab === 'uploads' ? 'bg-yellow-500/20' : 'bg-yellow-500/20'} flex items-center justify-center`}>
                                            <div className="w-2 h-2 bg-yellow-500 rounded-full" />
                                        </div>
                                    )}
                                    {(item.status === 'uploading' || item.status === 'downloading') && (
                                        <div className={`w-4 h-4 rounded-full border-2 ${effectiveTab === 'uploads' ? 'border-nobuf-ocean-green' : 'border-nobuf-secondary'} border-t-transparent animate-spin`} />
                                    )}
                                    {item.status === 'success' && (
                                        <div className="w-4 h-4 rounded-full bg-green-500/20 flex items-center justify-center">
                                            <Check className="w-3 h-3 text-green-500" />
                                        </div>
                                    )}
                                    {(item.status === 'error') && (
                                        <div className="w-4 h-4 rounded-full bg-red-500/20 flex items-center justify-center">
                                            <AlertCircle className="w-3 h-3 text-red-500" />
                                        </div>
                                    )}
                                    {item.status === 'cancelled' && (
                                        <div className="w-4 h-4 rounded-full bg-gray-500/20 flex items-center justify-center">
                                            <X className="w-3 h-3 text-gray-400" />
                                        </div>
                                    )}
                                </div>

                                {/* Filename */}
                                <div className="flex-1 text-nobuf-subtext text-xs line-clamp-2 break-all leading-snug" title={'filename' in item ? (item as DownloadItem).filename : (item as QueueItem).path}>
                                    {('filename' in item ? (item as DownloadItem).filename : (item as QueueItem).path || '').split('/').pop()}
                                </div>

                                {/* Cache info for downloads */}
                                {'cacheInfo' in item && item.cacheInfo && (
                                    <span className="text-[10px] text-nobuf-ocean-green flex-shrink-0">{item.cacheInfo}</span>
                                )}

                                {/* Action buttons */}
                                {(item.status === 'uploading' || item.status === 'downloading' || item.status === 'pending') && (
                                    <button
                                        onClick={() => effectiveTab === 'uploads' ? onCancelUploadItem(item.id) : onCancelDownloadItem(item.id)}
                                        className="text-gray-400 hover:text-red-400 transition-colors flex-shrink-0"
                                        title="Cancel"
                                    >
                                        <X className="w-3.5 h-3.5" />
                                    </button>
                                )}
                                {(item.status === 'error' || item.status === 'cancelled') && (
                                    <button
                                        onClick={() => effectiveTab === 'uploads' ? onRetryUploadItem(item.id) : onRetryDownloadItem(item.id)}
                                        className="text-gray-400 hover:text-nobuf-ocean-green transition-colors flex-shrink-0"
                                        title="Retry"
                                    >
                                        <RotateCcw className="w-3.5 h-3.5" />
                                    </button>
                                )}
                                {effectiveTab === 'uploads' && onDeleteUploadItem && (item.status === 'success' || item.status === 'error' || item.status === 'cancelled') && (
                                    <button onClick={() => onDeleteUploadItem(item.id)} className="text-gray-400 hover:text-red-400 transition-colors flex-shrink-0" title="Delete upload">
                                        <X className="w-3.5 h-3.5" />
                                    </button>
                                )}
                            </div>

                            {/* Progress bar */}
                            {(item.status === 'uploading' || item.status === 'downloading') && (
                                <>
                                    <div className="w-full bg-nobuf-border h-1 mt-1 rounded-full overflow-hidden">
                                        {item.progress !== undefined ? (
                                            <div
                                                className={`h-full rounded-full transition-all duration-300 ${
                                                    effectiveTab === 'uploads' ? 'bg-nobuf-ocean-green' : 'bg-nobuf-secondary'
                                                }`}
                                                style={{ width: `${item.progress}%` }}
                                            />
                                        ) : (
                                            <div className={`h-full w-full animate-progress-indeterminate ${
                                                effectiveTab === 'uploads' ? 'bg-nobuf-ocean-green' : 'bg-nobuf-secondary'
                                            }`} />
                                        )}
                                    </div>
                                    <div className="flex justify-between text-[10px] text-nobuf-subtext mt-0.5">
                                        <span>
                                            {item.uploadedBytes !== undefined && item.totalBytes !== undefined
                                                ? `${formatBytes(item.uploadedBytes)} / ${formatBytes(item.totalBytes)}`
                                                : item.progress !== undefined ? `${item.progress}%` : ''}
                                        </span>
                                        <span>
                                            {item.speedBytesPerSec !== undefined && item.speedBytesPerSec > 0
                                                ? `${formatBytes(item.speedBytesPerSec)}/s`
                                                : ''}
                                        </span>
                                    </div>
                                </>
                            )}

                            {/* Error message */}
                            {item.status === 'error' && item.error && (
                                <div className="flex items-center gap-1 text-[11px] text-red-400 mt-1">
                                    <span className="truncate">{item.error}</span>
                                </div>
                            )}

                            {/* Cancelled label */}
                            {item.status === 'cancelled' && (
                                <div className="text-[11px] text-gray-400 mt-0.5">Cancelled</div>
                            )}
                        </div>
                    ))
                )}
            </div>
        </div>
        </>
    );
}

/** Status glyph for a split-group header when there are no part rows to expand. */
function StatusDot({ phase }: { phase: string }) {
    const active = phase === 'running' || phase === 'splitting' || phase === 'uploading';
    if (phase === 'queued') {
        return (
            <div className="w-4 h-4 rounded-full bg-yellow-500/20 flex items-center justify-center">
                <div className="w-2 h-2 bg-yellow-500 rounded-full" />
            </div>
        );
    }
    if (active) {
        return <div className="w-4 h-4 rounded-full border-2 border-nobuf-primary border-t-transparent animate-spin" />;
    }
    if (phase === 'done') {
        return (
            <div className="w-4 h-4 rounded-full bg-green-500/20 flex items-center justify-center">
                <Check className="w-3 h-3 text-green-500" />
            </div>
        );
    }
    return (
        <div className="w-4 h-4 rounded-full bg-orange-500/20 flex items-center justify-center">
            <AlertCircle className="w-3 h-3 text-orange-400" />
        </div>
    );
}

/**
 * One per-part row inside an expanded split group. Action gating per plan §C:
 * waiting/splitting/uploading → Cancel(part) · failed/cancelled → Retry/Re-include ·
 * done → Play + Download.
 */
export function SplitPartRowView({
    part, jobPhase, onCancel, onRetry, onPlay, onDownload,
}: {
    part: SplitPartRow;
    jobPhase: string;
    onCancel?: () => void;
    onRetry?: () => void;
    onPlay?: () => void;
    onDownload?: () => void;
}) {
    // While the JOB is running, an in-flight part shows live pct/speed; the
    // backend's authoritative status word arrives via partStatus flips.
    const live = jobPhase === 'running' || jobPhase === 'splitting' || jobPhase === 'uploading'
        ? ['splitting', 'uploading'].includes(part.status)
        : false;
    const cancellable = live || (part.status === 'waiting' && (jobPhase === 'running' || jobPhase === 'splitting' || jobPhase === 'uploading'));
    const statusLabel =
        part.status === 'waiting' ? 'waiting'
        : part.status === 'splitting' ? 'splitting…'
        : part.status === 'uploading' ? `uploading${part.pct !== undefined ? ` ${Math.round(part.pct)}%` : ''}${part.speedBps ? ` · ${formatSpeed(part.speedBps)}` : ''}`
        : part.status === 'done' ? formatBytes(part.sizeBytes)
        : part.status === 'cancelled' ? 'skipped'
        : part.status === 'failed' ? 'failed'
        : part.status;
    return (
        <div
            data-part-row={part.idx}
            className={`flex flex-col gap-0.5 pl-7 pr-1 py-1 rounded-md text-[11px] ${live ? 'bg-nobuf-primary/5' : ''}`}
        >
            <div className="flex items-center gap-2">
                <span className={`font-mono w-8 shrink-0 ${live ? 'text-nobuf-primary' : 'text-nobuf-subtext'}`}>
                    #{String(part.idx).padStart(2, '0')}
                </span>
                <span className="flex-1 min-w-0 truncate text-nobuf-text">{part.name}</span>
                <span className={`shrink-0 tabular-nums ${live ? 'text-nobuf-primary' : part.status === 'failed' ? 'text-red-400' : part.status === 'cancelled' ? 'text-white/40' : 'text-nobuf-subtext'}`}>
                    {statusLabel}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                    {cancellable && onCancel && (
                        <button onClick={onCancel} title={part.status === 'waiting' ? 'Skip this part — it will not be uploaded unless you retry it later' : 'Cancel this part — other parts are unaffected'}
                            className="text-gray-400 hover:text-red-400 transition-colors p-0.5">
                            <X className="w-3 h-3" />
                        </button>
                    )}
                    {(part.status === 'failed' || part.status === 'cancelled') && onRetry && (
                        <button onClick={onRetry}
                            title={part.status === 'cancelled' ? 'Re-include this part and continue' : 'Retry this part'}
                            className="flex items-center gap-0.5 text-nobuf-primary hover:text-nobuf-text transition-colors px-1 py-0.5 rounded bg-nobuf-primary/10 hover:bg-nobuf-primary/20">
                            <RotateCcw className="w-3 h-3" /> Retry
                        </button>
                    )}
                    {part.status === 'done' && part.messageId != null && onPlay && (
                        <button onClick={onPlay} title="Play this part from its own beginning"
                            className="text-nobuf-subtext hover:text-nobuf-primary transition-colors p-0.5">
                            <Play className="w-3 h-3" />
                        </button>
                    )}
                    {part.status === 'done' && part.messageId != null && onDownload && (
                        <button onClick={onDownload} title="Download this part to your PC"
                            className="text-nobuf-subtext hover:text-green-400 transition-colors p-0.5">
                            <Download className="w-3 h-3" />
                        </button>
                    )}
                </div>
            </div>
            {/* Per-part progress bar while splitting/uploading */}
            {live && (
                <div className="w-full bg-nobuf-border h-0.5 rounded-full overflow-hidden">
                    <div
                        className={`h-full rounded-full transition-all duration-300 ${part.status === 'splitting' ? 'bg-yellow-400/70 animate-pulse' : 'bg-nobuf-primary'}`}
                        style={{ width: `${part.status === 'uploading' && part.pct !== undefined ? Math.min(100, Math.round(part.pct)) : part.status === 'splitting' ? 100 : 0}%` }}
                    />
                </div>
            )}
        </div>
    );
}

