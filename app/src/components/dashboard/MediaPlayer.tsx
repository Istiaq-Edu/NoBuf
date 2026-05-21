import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { TelegramFile } from '../../types';
import { FastStreamPlayer } from './FastStreamPlayer';

interface StreamInfo {
    token: string;
    base_url: string;
}

interface MediaPlayerProps {
    file: TelegramFile;
    onClose: () => void;
    onNext?: () => void;
    onPrev?: () => void;
    currentIndex?: number;
    totalItems?: number;
    activeFolderId: number | null;
    onContinueToDownload?: (messageId: number, filename: string, folderId: number | null, savePath: string, fromCachePercent: number) => void;
}

export function MediaPlayer({ file, onClose, onNext, onPrev, activeFolderId, onContinueToDownload }: MediaPlayerProps) {
    const [streamInfo, setStreamInfo] = useState<StreamInfo | null>(null);

    useEffect(() => {
        invoke<StreamInfo>('cmd_get_stream_info').then(setStreamInfo).catch(() => {});
    }, []);

    const folderIdParam = activeFolderId !== null ? activeFolderId.toString() : 'home';
    const streamUrl = streamInfo
        ? `${streamInfo.base_url}/stream/${folderIdParam}/${file.id}?token=${streamInfo.token}`
        : null;

    useEffect(() => {
        console.log(`[MediaPlayer] Stream URL resolved: ${streamUrl}, fileId: ${file.id}`);
    }, [streamUrl, file.id]);

    if (!streamUrl) {
        return null;
    }

    return (
        <FastStreamPlayer
            file={file}
            streamUrl={streamUrl}
            onClose={onClose}
            onNext={onNext}
            onPrev={onPrev}
            activeFolderId={activeFolderId}
            onContinueToDownload={onContinueToDownload}
        />
    );
}
