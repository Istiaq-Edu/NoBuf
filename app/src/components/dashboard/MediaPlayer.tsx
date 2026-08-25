import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { TelegramFile } from '../../types';
import { FastStreamPlayer } from './FastStreamPlayer';
import { globalTimeToPart, type SplitChain } from '../../utils/splitChain';

interface StreamInfo {
    token: string;
    base_url: string;
    video_base_url: string;
}

interface MediaPlayerProps {
    /** The clicked file — in chain mode this is the FIRST part of a split set. */
    file: TelegramFile;
    onClose: () => void;
    onNext?: () => void;
    onPrev?: () => void;
    currentIndex?: number;
    totalItems?: number;
    activeFolderId: number | null;
    onContinueToDownload?: (messageId: number, filename: string, folderId: number | null, savePath: string, fromCachePercent: number) => void;
    isAlreadyDownloading?: boolean;
    isPublicChannel?: boolean;
    /** Chain mode payload: consecutive split parts of one logical video. */
    chain?: SplitChain;
    /** Global virtual-timeline start position (seconds). */
    startAtT?: number;
}

export function MediaPlayer({ file, onClose, onNext, onPrev, activeFolderId, isAlreadyDownloading, isPublicChannel, chain, startAtT = 0 }: MediaPlayerProps) {
    const [streamInfo, setStreamInfo] = useState<StreamInfo | null>(null);

    useEffect(() => {
        invoke<StreamInfo>('cmd_get_stream_info').then(setStreamInfo).catch(() => {});
    }, []);

    const folderIdParam = activeFolderId !== null ? activeFolderId.toString() : 'home';

    // ── Chain mode ─────────────────────────────────────────────────────────
    // `chain.parts` are consecutive split parts (first missing index rule).
    // partIdx state drives WHICH part's streamUrl the player gets; bumping it
    // remounts FastStreamPlayer (fresh MediaSource — D0 decision). startAtT is
    // a GLOBAL virtual-timeline time → resolved to (initial part, offset) once.
    const initial = useMemo(
        () => (chain ? globalTimeToPart(chain, startAtT) : { index: 0, offset: 0 }),
        [chain, startAtT],
    );
    const [partIdx, setPartIdx] = useState(initial.index);
    useEffect(() => { setPartIdx(globalTimeToPart(chain ?? { kind: 'chain', stem: '', ext: '', parts: [], totalDuration: 0, totalSize: 0 }, 0).index); }, [file.id]); // reset on new file
    const activePart = chain?.parts[partIdx] ?? null;
    const chainFile: TelegramFile | null = useMemo(() => {
        if (!chain || !activePart) return null;
        return { ...file, id: activePart.id, name: activePart.name, size: activePart.size, duration: activePart.duration };
    }, [chain, activePart, file]);

    const displayFile = chain ? (chainFile ?? file) : file;

    const streamUrl = streamInfo
        ? `${streamInfo.base_url}/stream/${folderIdParam}/${displayFile.id}?token=${streamInfo.token}`
        : null;

    if (!streamUrl) {
        return null;
    }

    return (
        <FastStreamPlayer
            key={chain ? `part-${partIdx}-${displayFile.id}` : 'media-player'}
            file={displayFile}
            streamUrl={streamUrl}
            onClose={onClose}
            onNext={onNext}
            onPrev={onPrev}
            onPartEnded={
                chain
                    ? () => {
                        // Last part finished → no-op lets the built-in replay
                        // overlay take over; otherwise advance to next part.
                        if (partIdx < (chain?.parts.length ?? 1) - 1) setPartIdx((i: number) => i + 1);
                    }
                    : undefined
            }
            initialSeekS={chain && partIdx === initial.index && initial.offset > 0.05 ? initial.offset : undefined}
            activeFolderId={activeFolderId}
            isAlreadyDownloading={isAlreadyDownloading}
            isPublicChannel={isPublicChannel}
        />
    );
}
