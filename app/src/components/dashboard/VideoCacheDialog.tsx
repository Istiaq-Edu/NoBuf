import { useCallback, useEffect, useRef } from 'react';
import { save } from '@tauri-apps/plugin-dialog';

interface VideoCacheDialogProps {
    percentage: number;
    filename: string;
    messageId: number;
    isAlreadyDownloading: boolean;
    onDiscard: () => void;
    onKeepBuffers: () => void;
    onContinueDownload: (savePath: string) => void;
    onAlreadyDownloadingClose: () => void;
    onCancel: () => void;
}

export function VideoCacheDialog({
    percentage,
    filename,
    messageId,
    isAlreadyDownloading,
    onDiscard,
    onKeepBuffers,
    onContinueDownload,
    onAlreadyDownloadingClose,
    onCancel,
}: VideoCacheDialogProps) {
    const dialogRef = useRef<HTMLDivElement>(null);

    // Escape key handler
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onCancel();
            }
        };
        document.addEventListener('keydown', handleKey, true);
        return () => document.removeEventListener('keydown', handleKey, true);
    }, [onCancel, messageId]);

    // Handle Continue Download — open save dialog then proceed
    const handleContinueDownload = useCallback(async () => {
        try {
            const savePath = await save({ defaultPath: filename });
            if (!savePath) return;
            onContinueDownload(savePath);
        } catch { /* ignore */ }
    }, [filename, percentage, messageId, onContinueDownload]);

    const handleDiscard = useCallback(() => onDiscard(), [onDiscard]);
    const handleKeepBuffers = useCallback(() => onKeepBuffers(), [onKeepBuffers]);

    // Click outside dialog — cancel and return to player
    const handleBackdropClick = useCallback((e: React.MouseEvent) => {
        if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
            onCancel();
        }
    }, [onCancel]);

    const isFullyCached = percentage >= 100;

    // Short filename for display — truncate long names
    const shortName = filename.length > 35 ? filename.slice(0, 32) + '...' : filename;

    return (
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-md"
            onClick={handleBackdropClick}
        >
            <div
                ref={dialogRef}
                className="relative bg-[#161b16]/95 backdrop-blur-xl border border-nobuf-primary/15 rounded-2xl p-6 w-[420px] max-w-[92vw] shadow-2xl shadow-black/40"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header — icon + title */}
                <div className="flex items-start gap-3 mb-5">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${isFullyCached ? 'bg-nobuf-primary/20 text-nobuf-primary' : 'bg-nobuf-secondary/20 text-nobuf-secondary'}`}>
                        {isFullyCached ? (
                            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                        ) : (
                            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
                        )}
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 className="text-[17px] font-semibold text-white mb-1.5">
                            {isFullyCached ? 'Video fully cached' : 'Video partially cached'}
                        </h3>
                        <p className="text-white/55 text-[13px] leading-relaxed break-words">
                            {isFullyCached
                                ? `"${shortName}" is fully cached locally. Keep it for faster access, or save it to your device.`
                                : `${percentage}% of "${shortName}" is cached locally. Choose what to do with this data.`}
                        </p>
                    </div>
                </div>

                {/* X button */}
                <button
                    onClick={onCancel}
                    className="absolute top-4 right-4 p-1.5 rounded-lg text-white/35 hover:text-white/80 hover:bg-white/10 transition-all"
                    title="Return to video (Esc)"
                >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                    </svg>
                </button>

                {/* Divider */}
                <div className="border-t border-white/8 mb-5" />

                {/* Action buttons */}
                <div className="flex flex-col gap-2.5">
                    {/* Continue Download — primary action */}
                    {isAlreadyDownloading ? (
                        <button
                            onClick={onAlreadyDownloadingClose}
                            className="px-4 py-3 rounded-xl text-sm font-medium transition-all bg-nobuf-primary/15 text-white/80 hover:bg-nobuf-primary/25 text-left group"
                        >
                            <div className="flex items-center gap-2.5">
                                <svg className="w-4 h-4 text-nobuf-primary shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                                <span className="text-white/80">Continue Download in Transfer Panel</span>
                            </div>
                            <span className="block text-[11px] text-white/35 mt-1.5 ml-[26px]">
                                This file is already downloading — check the transfer panel
                            </span>
                        </button>
                    ) : (
                        <button
                            onClick={handleContinueDownload}
                            className="px-4 py-3 rounded-xl text-sm font-medium transition-all bg-nobuf-primary text-white hover:bg-nobuf-primary/90 shadow-lg shadow-nobuf-primary/25 text-left group"
                        >
                            <div className="flex items-center gap-2.5">
                                <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                                <span className="font-medium">Continue Download</span>
                            </div>
                            <span className="block text-[11px] text-white/60 mt-1.5 ml-[26px]">
                                {isFullyCached
                                    ? 'Save the fully cached file to your device'
                                    : `Download from ${percentage}% cache — choose where to save`}
                            </span>
                        </button>
                    )}

                    {/* Keep Buffers — secondary positive action */}
                    <button
                        onClick={handleKeepBuffers}
                        className="px-4 py-3 rounded-xl text-sm font-medium transition-all bg-nobuf-primary/10 text-nobuf-primary hover:bg-nobuf-primary/20 hover:text-white text-left group"
                    >
                        <div className="flex items-center gap-2.5">
                            <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
                            <span className="text-nobuf-primary">Keep Current Buffers</span>
                        </div>
                        <span className="block text-[11px] text-white/35 mt-1.5 ml-[26px]">
                            {isFullyCached
                                ? 'Cache kept for this session — faster access until app closes'
                                : `Keep ${percentage}% cached this session — badge shown on file`}
                        </span>
                    </button>

                    {/* Close & Discard — destructive action */}
                    <button
                        onClick={handleDiscard}
                        disabled={isAlreadyDownloading}
                        className={`px-4 py-3 rounded-xl text-sm font-medium transition-all text-left group ${isAlreadyDownloading ? 'bg-red-500/5 text-red-400/25 cursor-not-allowed' : 'bg-red-500/8 text-red-400 hover:bg-red-500/15 hover:text-red-300'}`}
                    >
                        <div className="flex items-center gap-2.5">
                            <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                            <span className="text-red-400">Close & Discard Cache</span>
                        </div>
                        <span className="block text-[11px] mt-1.5 ml-[26px]" style={{ color: isAlreadyDownloading ? 'rgba(239,68,68,0.2)' : 'rgba(239,68,68,0.4)' }}>
                            {isAlreadyDownloading ? 'Cannot discard — active download is using this cache' : 'Delete cached data — next playback starts from scratch'}
                        </span>
                    </button>
                </div>
            </div>
        </div>
    );
}
