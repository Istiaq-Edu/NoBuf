import { useState } from 'react';
import { Upload, Download, X, RotateCcw, AlertCircle, Check } from 'lucide-react';
import { QueueItem, DownloadItem } from '../../types';

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

type Tab = 'uploads' | 'downloads';

interface TransferPanelProps {
    isOpen: boolean;
    onClose: () => void;
    // Upload props
    uploadItems: QueueItem[];
    onClearUploadFinished: () => void;
    onCancelAllUploads: () => void;
    onCancelUploadItem: (id: string) => void;
    onRetryUploadItem: (id: string) => void;
    // Download props
    downloadItems: DownloadItem[];
    onClearDownloadFinished: () => void;
    onCancelAllDownloads: () => void;
    onCancelDownloadItem: (id: string) => void;
    onRetryDownloadItem: (id: string) => void;
}

export function TransferPanel({
    isOpen, onClose,
    uploadItems, onClearUploadFinished, onCancelAllUploads, onCancelUploadItem, onRetryUploadItem,
    downloadItems, onClearDownloadFinished, onCancelAllDownloads, onCancelDownloadItem, onRetryDownloadItem,
}: TransferPanelProps) {
    const [activeTab, setActiveTab] = useState<Tab>('uploads');

    const uploadActive = uploadItems.filter(i => i.status === 'pending' || i.status === 'uploading').length;
    const downloadActive = downloadItems.filter(i => i.status === 'pending' || i.status === 'downloading').length;

    // Auto-switch to tab with active items
    const effectiveTab = activeTab;

    const items = effectiveTab === 'uploads' ? uploadItems : downloadItems;
    const hasPendingOrActive = effectiveTab === 'uploads'
        ? uploadItems.some(i => i.status === 'pending' || i.status === 'uploading')
        : downloadItems.some(i => i.status === 'pending' || i.status === 'downloading');
    const hasFinished = effectiveTab === 'uploads'
        ? uploadItems.some(i => i.status === 'success' || i.status === 'error' || i.status === 'cancelled')
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
                className={`fixed right-0 top-14 bottom-0 w-[380px] bg-telegram-surface border-l border-telegram-border shadow-2xl z-40 flex flex-col transition-transform duration-300 ease-in-out ${
                    isOpen ? 'translate-x-0' : 'translate-x-full'
                }`}
            >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-telegram-border bg-telegram-hover/50">
                <h3 className="text-sm font-semibold text-telegram-text">Transfers</h3>
                <button
                    onClick={onClose}
                    className="p-1 hover:bg-telegram-border rounded text-telegram-subtext hover:text-telegram-text transition-colors"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-telegram-border">
                <button
                    onClick={() => setActiveTab('uploads')}
                    className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-medium transition-colors relative ${
                        effectiveTab === 'uploads'
                            ? 'text-telegram-primary'
                            : 'text-telegram-subtext hover:text-telegram-text'
                    }`}
                >
                    <Upload className="w-3.5 h-3.5" />
                    Uploads
                    {uploadActive > 0 && (
                        <span className="px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded-full text-[10px]">
                            {uploadActive}
                        </span>
                    )}
                    {effectiveTab === 'uploads' && (
                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-telegram-primary" />
                    )}
                </button>
                <button
                    onClick={() => setActiveTab('downloads')}
                    className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-medium transition-colors relative ${
                        effectiveTab === 'downloads'
                            ? 'text-telegram-primary'
                            : 'text-telegram-subtext hover:text-telegram-text'
                    }`}
                >
                    <Download className="w-3.5 h-3.5" />
                    Downloads
                    {downloadActive > 0 && (
                        <span className="px-1.5 py-0.5 bg-telegram-secondary/20 text-telegram-secondary rounded-full text-[10px]">
                            {downloadActive}
                        </span>
                    )}
                    {effectiveTab === 'downloads' && (
                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-telegram-primary" />
                    )}
                </button>
            </div>

            {/* Actions bar */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-telegram-border/50">
                <span className="text-[11px] text-telegram-subtext">
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
                            onClick={effectiveTab === 'uploads' ? onClearUploadFinished : onClearDownloadFinished}
                            className="text-[11px] text-telegram-primary hover:text-telegram-text transition-colors"
                        >
                            Clear Finished
                        </button>
                    )}
                </div>
            </div>

            {/* Items list */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {items.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-telegram-subtext">
                        {effectiveTab === 'uploads' ? (
                            <Upload className="w-8 h-8 mb-2 opacity-30" />
                        ) : (
                            <Download className="w-8 h-8 mb-2 opacity-30" />
                        )}
                        <span className="text-xs">No {effectiveTab} yet</span>
                    </div>
                ) : (
                    items.map(item => (
                        <div key={item.id} className="flex flex-col gap-1 p-2.5 bg-telegram-hover rounded-lg">
                            <div className="flex items-center gap-3 text-sm">
                                {/* Status icon */}
                                <div className="flex-shrink-0">
                                    {item.status === 'pending' && (
                                        <div className={`w-4 h-4 rounded-full ${effectiveTab === 'uploads' ? 'bg-yellow-500/20' : 'bg-yellow-500/20'} flex items-center justify-center`}>
                                            <div className="w-2 h-2 bg-yellow-500 rounded-full" />
                                        </div>
                                    )}
                                    {(item.status === 'uploading' || item.status === 'downloading') && (
                                        <div className={`w-4 h-4 rounded-full border-2 ${effectiveTab === 'uploads' ? 'border-blue-500' : 'border-telegram-secondary'} border-t-transparent animate-spin`} />
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
                                <div className="flex-1 text-telegram-subtext text-xs line-clamp-2 break-all leading-snug" title={'filename' in item ? (item as DownloadItem).filename : (item as QueueItem).path}>
                                    {('filename' in item ? (item as DownloadItem).filename : (item as QueueItem).path || '').split('/').pop()}
                                </div>

                                {/* Cache info for downloads */}
                                {'cacheInfo' in item && item.cacheInfo && (
                                    <span className="text-[10px] text-blue-400 flex-shrink-0">{item.cacheInfo}</span>
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
                                        className="text-gray-400 hover:text-blue-400 transition-colors flex-shrink-0"
                                        title="Retry"
                                    >
                                        <RotateCcw className="w-3.5 h-3.5" />
                                    </button>
                                )}
                            </div>

                            {/* Progress bar */}
                            {(item.status === 'uploading' || item.status === 'downloading') && (
                                <>
                                    <div className="w-full bg-telegram-border h-1 mt-1 rounded-full overflow-hidden">
                                        {item.progress !== undefined ? (
                                            <div
                                                className={`h-full rounded-full transition-all duration-300 ${
                                                    effectiveTab === 'uploads' ? 'bg-blue-500' : 'bg-telegram-secondary'
                                                }`}
                                                style={{ width: `${item.progress}%` }}
                                            />
                                        ) : (
                                            <div className={`h-full w-full animate-progress-indeterminate ${
                                                effectiveTab === 'uploads' ? 'bg-blue-500' : 'bg-telegram-secondary'
                                            }`} />
                                        )}
                                    </div>
                                    <div className="flex justify-between text-[10px] text-telegram-subtext mt-0.5">
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
