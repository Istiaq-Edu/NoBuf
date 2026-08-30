export interface TelegramFile {
    id: number;
    name: string;
    size: number;
    sizeStr: string;
    created_at?: string;
    type?: 'folder' | 'file';
    duration?: number;
}

export interface TelegramFolder {
    id: number;
    name: string;
    parent_id?: number;
    /** True when this folder is an adopted owned/administered channel (not a [NB]-tagged channel). Drives sidebar menu gating (Unadopt vs Delete). */
    is_adopted?: boolean;
}

export interface ScanResult {
    added: TelegramFolder[];
    updated: TelegramFolder[];
    removed: number[];
}

export interface QueueItem {
    id: string;
    path: string;
    folderId: number | null;
    status: 'pending' | 'uploading' | 'success' | 'error' | 'cancelled';
    error?: string;
    progress?: number; // 0-100
    uploadedBytes?: number;
    totalBytes?: number;
    speedBytesPerSec?: number;
    url?: string; // For remote upload from URL
    phase?: 'downloading' | 'uploading'; // For remote upload dual-phase progress
    stagedTempPath?: string; // Dropped-file staging: %TEMP%\nobuf_dropped path, deleted on terminal states. NEVER persisted to the store (a restart sweeps the dir).
    displayName?: string; // Dropped-file staging: original name sent to Telegram (the temp filename carries a random <id>- prefix that must not leak)
    messageId?: number; // Telegram message created by a successful upload
}

export interface BandwidthStats {
    up_bytes: number;
    down_bytes: number;
}

export interface DownloadItem {
    id: string;
    messageId: number;
    filename: string;
    folderId: number | null;
    status: 'pending' | 'downloading' | 'success' | 'error' | 'cancelled';
    error?: string;
    progress?: number; // 0-100
    uploadedBytes?: number;
    totalBytes?: number;
    speedBytesPerSec?: number;
    cacheInfo?: string; // "From cache" or "Using cache (67%)"
    fromCachePercent?: number; // Initial progress from cached video data (e.g. 45)
}

export interface PublicChannel {
    channel_id: number;
    name: string;
    username: string | null;
    access_hash: number;
    is_private: boolean;
    added_at: number;
    is_member: boolean;
}

export interface ChannelPreview {
    title: string;
    about: string | null;
    participants_count: number;
    is_channel: boolean;
    is_private: boolean;
    already_joined: boolean;
    channel_id: number | null;
    access_hash: number | null;
    username: string | null;
}

export interface JoinedChannel {
    channel_id: number;
    name: string;
    username: string | null;
    access_hash: number;
    already_added: boolean;
    is_nb_folder: boolean;
    is_creator?: boolean;
    is_admin_post?: boolean;
}

export interface AdoptedFolder {
    channel_id: number;
    access_hash: number;
    title: string;
    adopted_at: number;
}

export interface ForwardResult {
    success: boolean;
    forwarded_count: number;
    errors: string[];
}

export type ActiveView =
    | { type: 'saved' }
    | { type: 'folder'; folderId: number }
    | { type: 'public'; channelId: number }
    | { type: 'vault' };

/** Drag MIME marking a dragged public channel (vault-hide source). */
export const PUBLIC_CHANNEL_DRAG_MIME = 'application/x-nobuf-public-channel';
