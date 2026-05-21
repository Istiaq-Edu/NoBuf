import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save, open } from '@tauri-apps/plugin-dialog';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { DownloadItem, TelegramFile } from '../types';
import type { Store } from '@tauri-apps/plugin-store';

interface ProgressPayload {
    id: string;
    percent: number;
    uploaded_bytes: number;
    total_bytes: number;
    speed_bytes_per_sec: number;
}

// Helper: Delete cache data with retry after cancelling a download.
// The download task's file handle may still be open when cmd_cancel_transfer
// is called. We delay 2 seconds (giving the Rust task time to check the
// cancellation flag and close its handle) then retry up to 3 times.
function deleteCacheAfterCancel(messageId: number) {
    const tryDelete = (attempt: number) => {
        // console.log(`[CACHE-DOWNLOAD] Deleting cache for msg=${messageId} (attempt ${attempt})`);
        invoke('cmd_delete_cache', { messageId }).catch(() => {
            // console.warn(`[CACHE-DOWNLOAD] Cache deletion attempt ${attempt} failed for msg=${messageId}:`, e);
            if (attempt < 3) {
                setTimeout(() => tryDelete(attempt + 1), 2000);
            }
        });
    };
    setTimeout(() => tryDelete(1), 2000);
}

export function useFileDownload(store: Store | null) {
    const [downloadQueue, setDownloadQueue] = useState<DownloadItem[]>([]);
    const [processing, setProcessing] = useState(false);
    const [initialized, setInitialized] = useState(false);
    const cancelledRef = useRef<Set<string>>(new Set());

    // Listen for progress events from Rust
    useEffect(() => {
        let unlisten: UnlistenFn | undefined;
        listen<ProgressPayload>('download-progress', (event) => {
            setDownloadQueue(q => q.map(i =>
                i.id === event.payload.id && i.status !== 'cancelled' && i.status !== 'error' ? {
                    ...i,
                    progress: event.payload.percent,
                    uploadedBytes: event.payload.uploaded_bytes,
                    totalBytes: event.payload.total_bytes,
                    speedBytesPerSec: event.payload.speed_bytes_per_sec,
                } : i
            ));
        }).then(fn => { unlisten = fn; });
        return () => { unlisten?.(); };
    }, []);

    // Load saved queue on mount
    useEffect(() => {
        if (!store || initialized) return;
        store.get<DownloadItem[]>('downloadQueue').then((saved) => {
            if (saved && saved.length > 0) {
                const pending = saved.filter(i => i.status === 'pending');
                if (pending.length > 0) {
                    setDownloadQueue(pending);
                    toast.info(`Restored ${pending.length} pending downloads`);
                }
            }
            setInitialized(true);
        });
    }, [store, initialized]);

    // Save queue when it changes (only pending items)
    useEffect(() => {
        if (!store || !initialized) return;
        const pending = downloadQueue.filter(i => i.status === 'pending');
        store.set('downloadQueue', pending).then(() => store.save());
    }, [store, downloadQueue, initialized]);

    // Queue Processor
    useEffect(() => {
        if (processing) return;
        const nextItem = downloadQueue.find(i => i.status === 'pending');
        if (nextItem) {
            processItem(nextItem);
        }
    }, [downloadQueue, processing]);

    const processItem = async (item: DownloadItem) => {
        setProcessing(true);
        setDownloadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'downloading', progress: 0 } : i));

        try {
            const savePath = await save({ defaultPath: item.filename });
            if (!savePath) {
                setDownloadQueue(q => q.filter(i => i.id !== item.id));
                setProcessing(false);
                return;
            }

            await invoke('cmd_download_file', {
                messageId: item.messageId,
                savePath,
                folderId: item.folderId,
                transferId: item.id
            });

            if (cancelledRef.current.has(item.id)) {
                cancelledRef.current.delete(item.id);
            } else {
                setDownloadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'success', progress: 100 } : i));
                toast.success(`Downloaded: ${item.filename}`);
            }
        } catch (e) {
            if (!cancelledRef.current.has(item.id)) {
                const errMsg = String(e);
                if (errMsg.includes('Transfer cancelled')) {
                    setDownloadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'cancelled' } : i));
                } else {
                    setDownloadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'error', error: errMsg } : i));
                    toast.error(`Download failed: ${item.filename}`);
                }
            } else {
                cancelledRef.current.delete(item.id);
            }
        } finally {
            setProcessing(false);
        }
    };

    const queueDownload = async (messageId: number, filename: string, folderId: number | null) => {
        // Check cache status
        let cacheInfo: string | undefined;
        try {
            const cacheStatus = await invoke<any>('cmd_get_cache_status', { messageId });
            if (cacheStatus) {
                if (cacheStatus.is_complete) {
                    cacheInfo = 'From cache ✓';
                } else if (cacheStatus.percentage > 0) {
                    cacheInfo = `Using cache (${cacheStatus.percentage}%)`;
                }
            }
        } catch {
            // No cache, proceed normally
        }

        const newItem: DownloadItem = {
            id: Math.random().toString(36).substr(2, 9),
            messageId,
            filename,
            folderId,
            status: 'pending',
            cacheInfo,
        };
        setDownloadQueue(prev => [...prev, newItem]);
    };

    const queueBulkDownload = async (files: TelegramFile[], folderId: number | null) => {
        const dirPath = await open({
            directory: true,
            multiple: false,
            title: "Select Download Destination"
        });
        if (!dirPath) return;

        for (const file of files) {
            const newItem: DownloadItem = {
                id: Math.random().toString(36).substr(2, 9),
                messageId: file.id,
                filename: file.name,
                folderId,
                status: 'pending'
            };
            setDownloadQueue(prev => [...prev, newItem]);
        }

        toast.info(`Queued ${files.length} files for download`);
    };

    const clearFinished = () => {
        setDownloadQueue(q => q.filter(i => i.status !== 'success' && i.status !== 'error' && i.status !== 'cancelled'));
    };

    const cancelAll = () => {
        setDownloadQueue(q => {
            const downloading = q.find(i => i.status === 'downloading');
            if (downloading) {
                cancelledRef.current.add(downloading.id);
                invoke('cmd_cancel_transfer', { transferId: downloading.id }).catch(() => {});
            }
            // Delete cache data for any cache-based downloads being cancelled
            // (delayed — download task needs time to close its file handle)
            q.forEach(item => {
                if ((item.status === 'downloading' || item.status === 'pending') && item.fromCachePercent && item.messageId) {
                    // console.log(`[CACHE-DOWNLOAD] CancelAll: scheduling cache deletion for msg=${item.messageId}`);
                    deleteCacheAfterCancel(item.messageId);
                }
            });
            return q
                .filter(i => i.status !== 'pending')
                .map(i => i.status === 'downloading' ? { ...i, status: 'cancelled' as const } : i);
        });
        toast.info('All downloads cancelled');
    };

    const cancelItem = (id: string) => {
        setDownloadQueue(q => {
            const item = q.find(i => i.id === id);
            if (item?.status === 'downloading') {
                cancelledRef.current.add(id);
                invoke('cmd_cancel_transfer', { transferId: id }).catch(() => {});
                // If this download originated from "Continue Download from cache",
                // also delete the cache data since the user is discarding the intent.
                // Delayed — the download task needs time to close its file handle.
                if (item.fromCachePercent && item.messageId) {
                    // console.log(`[CACHE-DOWNLOAD] Cancelling cache-based download for msg=${item.messageId} — scheduling cache deletion`);
                    deleteCacheAfterCancel(item.messageId);
                }
                return q.map(i => i.id === id ? { ...i, status: 'cancelled' as const } : i);
            }
            if (item?.status === 'pending') {
                // Also delete cache for pending cache-based downloads
                if (item.fromCachePercent && item.messageId) {
                    // console.log(`[CACHE-DOWNLOAD] Removing pending cache-based download for msg=${item.messageId} — scheduling cache deletion`);
                    deleteCacheAfterCancel(item.messageId);
                }
                return q.filter(i => i.id !== id);
            }
            return q;
        });
    };

    const retryItem = (id: string) => {
        setDownloadQueue(q => q.map(i =>
            i.id === id && (i.status === 'error' || i.status === 'cancelled')
                ? { ...i, status: 'pending' as const, error: undefined, progress: undefined, uploadedBytes: undefined, totalBytes: undefined, speedBytesPerSec: undefined }
                : i
        ));
    };

    // Queue a download with a pre-chosen save path and optional initial progress from cache.
    // Used by VideoCacheDialog "Continue Download" option.
    const queueDownloadWithSavePath = async (
        messageId: number,
        filename: string,
        folderId: number | null,
        savePath: string,
        fromCachePercent?: number,
    ) => {
        // console.log(`[CACHE-DOWNLOAD] queueDownloadWithSavePath: msg=${messageId} file="${filename}" savePath="${savePath}" fromCache=${fromCachePercent}%`);
        const id = `dl-${messageId}-${Date.now()}`;

        const newItem: DownloadItem = {
            id,
            messageId,
            filename,
            folderId,
            status: 'downloading',
            progress: fromCachePercent ?? 0,
            cacheInfo: fromCachePercent ? `Using cache (${fromCachePercent}%)` : undefined,
            fromCachePercent,
        };
        setDownloadQueue(prev => [...prev, newItem]);

        // Process immediately since save path is already chosen
        try {
            await invoke('cmd_download_file', {
                messageId,
                savePath,
                folderId,
                transferId: id,
            });

            if (!cancelledRef.current.has(id)) {
                setDownloadQueue(q => q.map(i => i.id === id ? { ...i, status: 'success', progress: 100 } : i));
                toast.success(`Downloaded: ${filename}`);
            }
        } catch (e: any) {
            const errMsg = String(e);
            if (errMsg.includes('Transfer cancelled') || errMsg.includes('Cancel')) {
                setDownloadQueue(q => q.map(i => i.id === id ? { ...i, status: 'cancelled' } : i));
            } else {
                setDownloadQueue(q => q.map(i => i.id === id ? { ...i, status: 'error', error: errMsg } : i));
                toast.error(`Download failed: ${errMsg}`);
            }
        }
    };

    return {
        downloadQueue,
        queueDownload,
        queueDownloadWithSavePath,
        queueBulkDownload,
        clearFinished,
        cancelAll,
        cancelItem,
        retryItem,
    };
}
