import { useCallback, useEffect, useRef } from 'react';
import { save } from '@tauri-apps/plugin-dialog';

interface VideoCacheDialogProps {
    percentage: number;
    filename: string;
    messageId: number;
    onDiscard: () => void;
    onKeepBuffers: () => void;
    onContinueDownload: (savePath: string) => void;
    onCancel: () => void;
}

export function VideoCacheDialog({
    percentage,
    filename,
    messageId,
    onDiscard,
    onKeepBuffers,
    onContinueDownload,
    onCancel,
}: VideoCacheDialogProps) {
    const dialogRef = useRef<HTMLDivElement>(null);

    // Escape key handler
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                // console.log(`[CACHE-DIALOG] Escape key pressed — canceling dialog for msg=${messageId}`);
                onCancel();
            }
        };
        document.addEventListener('keydown', handleKey, true);
        return () => document.removeEventListener('keydown', handleKey, true);
    }, [onCancel, messageId]);

    // Handle Continue Download — open save dialog then proceed
    const handleContinueDownload = useCallback(async () => {
        // console.log(`[CACHE-DIALOG] Continue Download selected for msg=${messageId} at ${percentage}%`);
        try {
            const savePath = await save({ defaultPath: filename });
            if (!savePath) {
                // User cancelled save dialog — return to cache dialog
                // console.log(`[CACHE-DIALOG] Save dialog cancelled for msg=${messageId} — returning to cache dialog`);
                return;
            }
            onContinueDownload(savePath);
        } catch (e) {
            // console.error(`[CACHE-DIALOG] Save dialog error for msg=${messageId}:`, e);
        }
    }, [filename, percentage, messageId, onContinueDownload]);

    const handleDiscard = useCallback(() => {
        // console.log(`[CACHE-DIALOG] Close & Discard selected for msg=${messageId}`);
        onDiscard();
    }, [messageId, onDiscard]);

    const handleKeepBuffers = useCallback(() => {
        // console.log(`[CACHE-DIALOG] Keep Buffers selected for msg=${messageId} at ${percentage}%`);
        onKeepBuffers();
    }, [messageId, percentage, onKeepBuffers]);

    // Click outside dialog (on backdrop) — cancel and return to player
    const handleBackdropClick = useCallback((e: React.MouseEvent) => {
        if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
            // console.log(`[CACHE-DIALOG] Backdrop click — canceling dialog for msg=${messageId}`);
            onCancel();
        }
    }, [onCancel, messageId]);

    const isFullyCached = percentage >= 100;

    return (
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm"
            onClick={handleBackdropClick}
        >
            <div
                ref={dialogRef}
                className="bg-[#1c1c1c] border border-white/10 rounded-xl p-6 w-[380px] shadow-2xl animate-in zoom-in-95"
                onClick={(e) => e.stopPropagation()}
            >
                {/* X button — top right */}
                <button
                    onClick={onCancel}
                    className="absolute top-3 right-3 p-1 hover:bg-white/10 rounded text-white/50 hover:text-white transition-colors"
                    title="Close dialog (return to video)"
                >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                    </svg>
                </button>

                {/* Title */}
                <h3 className="text-lg font-medium text-white mb-2">
                    {isFullyCached ? 'Video fully cached' : 'Video partially cached'}
                </h3>

                {/* Message */}
                <p className="text-telegram-subtext text-sm mb-6">
                    {isFullyCached
                        ? `${filename} is 100% cached locally. Keep it for faster access this session, or download it to your device.`
                        : `${percentage}% of "${filename}" is cached locally. Choose what to do with the cached data.`}
                </p>

                {/* Action buttons */}
                <div className="flex flex-col gap-2">
                    {/* Close & Discard */}
                    <button
                        onClick={handleDiscard}
                        className="px-4 py-2.5 rounded-lg text-sm font-medium transition bg-red-500/10 text-red-400 hover:bg-red-500/20 text-left"
                    >
                        Close & Discard Cache
                        <span className="block text-[11px] text-red-400/60 mt-0.5">Delete all cached data — next playback starts from scratch</span>
                    </button>

                    {/* Keep Buffers */}
                    <button
                        onClick={handleKeepBuffers}
                        className="px-4 py-2.5 rounded-lg text-sm font-medium transition bg-green-500/10 text-green-400 hover:bg-green-500/20 text-left"
                    >
                        Keep Current Buffers
                        <span className="block text-[11px] text-green-400/60 mt-0.5">
                            {isFullyCached
                                ? 'Cache kept for this session — faster access until app closes'
                                : `Keep ${percentage}% cached for this session — badge shown on file`}
                        </span>
                    </button>

                    {/* Continue Download */}
                    <button
                        onClick={handleContinueDownload}
                        className="px-4 py-2.5 rounded-lg text-sm font-medium transition bg-telegram-primary text-white hover:bg-telegram-primary/90 text-left"
                    >
                        Continue Download in Download Panel
                        <span className="block text-[11px] text-white/60 mt-0.5">
                            {isFullyCached
                                ? 'Save fully cached file to your device'
                                : `Download continues from ${percentage}% — choose where to save`}
                        </span>
                    </button>
                </div>
            </div>
        </div>
    );
}
