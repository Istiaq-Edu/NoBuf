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
}

export function MediaPlayer({ file, onClose, onNext, onPrev, activeFolderId }: MediaPlayerProps) {
    const [streamInfo, setStreamInfo] = useState<StreamInfo | null>(null);

    useEffect(() => {
        invoke<StreamInfo>('cmd_get_stream_info').then(setStreamInfo).catch(() => {});
    }, []);

    const folderIdParam = activeFolderId !== null ? activeFolderId.toString() : 'home';
    const streamUrl = streamInfo
        ? `${streamInfo.base_url}/stream/${folderIdParam}/${file.id}?token=${streamInfo.token}`
        : null;

    console.log(`[MediaPlayer] Stream URL: ${streamUrl}, base_url: ${streamInfo?.base_url}, folderId: ${folderIdParam}, fileId: ${file.id}`);

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
        />
    );
}
