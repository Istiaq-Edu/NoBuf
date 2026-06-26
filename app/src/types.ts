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
