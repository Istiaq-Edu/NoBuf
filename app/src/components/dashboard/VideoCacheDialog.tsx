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

    const handleContinueDownload = useCallback(async () => {
        try {
            const savePath = await save({ defaultPath: filename });
            if (!savePath) return;
            onContinueDownload(savePath);
        } catch { /* ignore */ }
    }, [filename, percentage, messageId, onContinueDownload]);

    const handleDiscard = useCallback(() => onDiscard(), [onDiscard]);
    const handleKeepBuffers = useCallback(() => onKeepBuffers(), [onKeepBuffers]);

    const handleBackdropClick = useCallback((e: React.MouseEvent) => {
        if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
            onCancel();
        }
    }, [onCancel]);

    const isFullyCached = percentage >= 100;
    const shortName = filename.length > 36 ? filename.slice(0, 33) + '...' : filename;

    const btnBase = 'w-full px-4 py-3 rounded-xl text-sm font-medium transition-all text-left';
    const btnSolid = 'shadow-sm hover:shadow-md';
    const btnGhost = 'cursor-not-allowed opacity-35';

    return (
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-md"
            onClick={handleBackdropClick}
        >
            <div
                ref={dialogRef}
                className="relative bg-[#161616]/98 backdrop-blur-xl border border-white/[0.06] rounded-2xl p-6 w-[420px] max-w-[92vw] shadow-2xl shadow-black/50"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-start gap-3 mb-5">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${isFullyCached ? 'bg-nobuf-spring-green/15 text-nobuf-spring-green' : 'bg-nobuf-ocean-green/15 text-nobuf-ocean-green'}`}>
                        {isFullyCached ? (
                            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                        ) : (
                            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
                        )}
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 className="text-[17px] font-semibold text-white mb-1">
                            {isFullyCached ? 'Video fully cached' : 'Video partially cached'}
                        </h3>
                        <p className="text-white/55 text-[13px] leading-relaxed break-words line-clamp-2">
                            {isFullyCached
                                ? `"${shortName}" is fully cached locally. Keep it for faster access, or save it to your device.`
                                : `${percentage}% of "${shortName}" is cached locally. Choose what to do with this data.`}
                        </p>
                    </div>
                </div>

                {/* X button */}
                <button
                    onClick={onCancel}
                    className="absolute top-4 right-4 p-1.5 rounded-lg text-white/30 hover:text-white/70 hover:bg-white/10 transition-all"
                    title="Return to video (Esc)"
                >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                    </svg>
                </button>

                {/* Divider */}
                <div className="border-t border-white/[0.06] mb-5" />

                {/* Action buttons — chooseable: solid filled; not chooseable: ghosted outline */}
                <div className="flex flex-col gap-2.5">
                    {/* Continue Download — solid mint when chooseable, ghost when not */}
                    <button
                        onClick={isAlreadyDownloading ? onAlreadyDownloadingClose : handleContinueDownload}
                        disabled={isAlreadyDownloading}
                        className={`${btnBase} ${isAlreadyDownloading ? btnGhost : btnSolid} ${isAlreadyDownloading ? 'border border-nobuf-spring-green/20 bg-transparent text-nobuf-spring-green/50' : 'bg-nobuf-spring-green text-nobuf-county-green hover:bg-nobuf-spring-green/90'}`}
                    >
                        <div className="flex items-center gap-2.5">
                            <svg className={`w-4 h-4 shrink-0 ${isAlreadyDownloading ? 'text-nobuf-spring-green/50' : 'text-nobuf-county-green'}`} fill="currentColor" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                            <span className={`font-medium ${isAlreadyDownloading ? 'text-nobuf-spring-green/50' : 'text-nobuf-county-green'}`}>{isAlreadyDownloading ? 'Continue Download in Transfer Panel' : 'Continue Download'}</span>
                        </div>
                        <span className={`block text-[11px] mt-1.5 ml-[26px] ${isAlreadyDownloading ? 'text-nobuf-spring-green/25' : 'text-nobuf-county-green/65'}`}>
                            {isAlreadyDownloading
                                ? 'This file is already downloading — check the transfer panel'
                                : isFullyCached
                                    ? 'Save the fully cached file to your device'
                                    : `Download from ${percentage}% cache — choose where to save`}
                        </span>
                    </button>

                    {/* Keep Buffers — always chooseable, solid teal */}
                    <button
                        onClick={handleKeepBuffers}
                        className={`${btnBase} ${btnSolid} bg-nobuf-ocean-green text-white hover:bg-nobuf-ocean-green/90`}
                    >
                        <div className="flex items-center gap-2.5">
                            <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
                            <span className="font-medium">Keep Current Buffers</span>
                        </div>
                        <span className="block text-[11px] text-white/65 mt-1.5 ml-[26px]">
                            {isFullyCached
                                ? 'Cache kept for this session — faster access until app closes'
                                : `Keep ${percentage}% cached this session — badge shown on file`}
                        </span>
                    </button>

                    {/* Discard Cache — solid red when chooseable, ghost when not */}
                    <button
                        onClick={handleDiscard}
                        disabled={isAlreadyDownloading}
                        className={`${btnBase} ${isAlreadyDownloading ? btnGhost : btnSolid} ${isAlreadyDownloading ? 'border border-red-400/20 bg-transparent text-red-400/50' : 'bg-red-500 text-white hover:bg-red-500/90'}`}
                    >
                        <div className="flex items-center gap-2.5">
                            <svg className={`w-4 h-4 shrink-0 ${isAlreadyDownloading ? 'text-red-400/50' : ''}`} fill="currentColor" viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                            <span className={`font-medium ${isAlreadyDownloading ? 'text-red-400/50' : ''}`}>Close & Discard Cache</span>
                        </div>
                        <span className={`block text-[11px] mt-1.5 ml-[26px] ${isAlreadyDownloading ? 'text-red-400/25' : 'text-white/65'}`}>
                            {isAlreadyDownloading
                                ? 'Cannot discard — active download is using this cache'
                                : 'Delete cached data — next playback starts from scratch'}
                        </span>
                    </button>
                </div>
            </div>
        </div>
    );
}
