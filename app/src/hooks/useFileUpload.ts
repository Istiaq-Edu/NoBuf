import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { QueueItem } from '../types';
import { useFileDrop } from './useFileDrop';
import type { Store } from '@tauri-apps/plugin-store';

interface ProgressPayload {
    id: string;
    percent: number;
    uploaded_bytes: number;
    total_bytes: number;
    speed_bytes_per_sec: number;
}

/**
 * QueueItems that may be written to the persistent store.
 * Staged dropped-file items point at %TEMP%\nobuf_dropped, which the startup sweep
 * deletes BEFORE restored items are read — persisting them would guarantee an
 * "Invalid path" failure toast per item on every relaunch. The original file is
 * still in the user's hands; they simply re-drop it.
 */
export function persistableQueueItems(items: QueueItem[]): QueueItem[] {
    return items.filter(i => !i.stagedTempPath);
}

/**
 * Best-effort delete of a staged temp file once its queue item reaches a terminal
 * state. Silent by design: NotFound means the sweep/another path already got it,
 * and a locked file must never turn a finished upload into an error toast.
 */
export function cleanupStagedTemp(item: Pick<QueueItem, 'stagedTempPath'>): void {
    if (!item.stagedTempPath) return;
    invoke('cmd_delete_staged_file', { path: item.stagedTempPath }).catch(() => {});
}

export function useFileUpload(activeFolderId: number | null, store: Store | null) {
    const queryClient = useQueryClient();
    const [uploadQueue, setUploadQueue] = useState<QueueItem[]>([]);
    const [processing, setProcessing] = useState(false);
    const [initialized, setInitialized] = useState(false);
    const [limitBytes, setLimitBytes] = useState(2_000_000_000);
    useEffect(() => { invoke<number>('cmd_upload_limit').then(setLimitBytes).catch(() => {}); }, []);
    const cancelledRef = useRef<Set<string>>(new Set());
    // Live mirror of uploadQueue for once-registered/async callbacks (dedupe on drop).
    const queueMirrorRef = useRef<QueueItem[]>([]);
    queueMirrorRef.current = uploadQueue;

    // Listen for progress events from Rust
    useEffect(() => {
        let unlisten: UnlistenFn | undefined;
        let unlistenRemote: UnlistenFn | undefined;
        listen<ProgressPayload>('upload-progress', (event) => {
            setUploadQueue(q => q.map(i =>
                i.id === event.payload.id && i.status !== 'cancelled' && i.status !== 'error' ? {
                    ...i,
                    progress: event.payload.percent,
                    uploadedBytes: event.payload.uploaded_bytes,
                    totalBytes: event.payload.total_bytes,
                    speedBytesPerSec: event.payload.speed_bytes_per_sec,
                    phase: i.url ? 'uploading' : undefined,
                } : i
            ));
        }).then(fn => { unlisten = fn; });
        // Remote upload download phase progress
        listen<ProgressPayload>('remote-upload-progress', (event) => {
            setUploadQueue(q => q.map(i =>
                i.id === event.payload.id && i.status !== 'cancelled' && i.status !== 'error' ? {
                    ...i,
                    progress: event.payload.percent,
                    uploadedBytes: event.payload.uploaded_bytes,
                    totalBytes: event.payload.total_bytes,
                    speedBytesPerSec: event.payload.speed_bytes_per_sec,
                    phase: 'downloading',
                } : i
            ));
        }).then(fn => { unlistenRemote = fn; });
        return () => { unlisten?.(); unlistenRemote?.(); };
    }, []);

    useEffect(() => {
        if (!store || initialized) return;
        store.get<QueueItem[]>('uploadQueue').then((saved) => {
            if (saved && saved.length > 0) {
                const pending = saved.filter(i => i.status === 'pending');
                if (pending.length > 0) {
                    setUploadQueue(pending);
                    toast.info(`Restored ${pending.length} pending uploads`);
                }
            }
            setInitialized(true);
        });
    }, [store, initialized]);

    useEffect(() => {
        if (!store || !initialized) return;
        const pending = persistableQueueItems(uploadQueue.filter(i => i.status === 'pending'));
        store.set('uploadQueue', pending).then(() => store.save());
    }, [store, uploadQueue, initialized]);

    useEffect(() => {
        if (processing) return;
        const nextItem = uploadQueue.find(i => i.status === 'pending');
        if (nextItem) {
            processItem(nextItem);
        }
    }, [uploadQueue, processing]);

    const processItem = async (item: QueueItem) => {
        setProcessing(true);
        setUploadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'uploading', progress: 0 } : i));
        try {
            if (item.url) {
                // Remote upload from URL
                await invoke('cmd_upload_from_url', { url: item.url, folderId: item.folderId, transferId: item.id });
            } else {
                // Local file upload — displayName carries the ORIGINAL dropped-file name
                // so the Telegram document isn't named after the <id>-prefixed temp file.
                await invoke('cmd_upload_file', { path: item.path, folderId: item.folderId, transferId: item.id, displayName: item.displayName ?? null });
            }
            // Check if cancelled during upload
            if (cancelledRef.current.has(item.id)) {
                cancelledRef.current.delete(item.id);
                cleanupStagedTemp(item);
            } else {
                setUploadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'success', progress: 100 } : i));
                cleanupStagedTemp(item);
                queryClient.invalidateQueries({ queryKey: ['files', item.folderId] });
            }
        } catch (e) {
            if (!cancelledRef.current.has(item.id)) {
                const errMsg = String(e);
                if (errMsg.includes('Transfer cancelled')) {
                    setUploadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'cancelled' } : i));
                    cleanupStagedTemp(item);
                } else {
                    // Terminal error keeps the staged temp file so Retry can re-upload it.
                    setUploadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'error', error: errMsg } : i));
                    toast.error(`Upload failed for ${item.displayName || item.path.split('/').pop()}: ${e}`);
                }
            } else {
                cancelledRef.current.delete(item.id);
                cleanupStagedTemp(item);
            }
        } finally {
            setProcessing(false);
        }
    };

    const handleManualUpload = async () => {
        try {
            const selected = await open({ multiple: true, directory: false });
            if (selected) {
                const paths = Array.isArray(selected) ? selected : [selected];
                // Pre-validate against the Premium-aware size limit (consistent with drop path).
                const kept: string[] = [];
                const oversized: string[] = [];
                for (const p of paths) {
                    try {
                        const size = await invoke<number>('cmd_file_size', { path: p });
                        if (size > limitBytes) { oversized.push(p.split(/[/\\]/).pop() || p); continue; }
                    } catch { /* if size probe fails, let the upload flow surface the error */ }
                    kept.push(p);
                }
                if (oversized.length > 0) {
                    const gb = Math.round(limitBytes / 1_000_000_000);
                    toast.error(`${oversized.length} file(s) exceed the ${gb} GB limit.`);
                }
                if (kept.length === 0) return;
                const newItems: QueueItem[] = kept.map((path: string) => ({
                    id: Math.random().toString(36).substr(2, 9),
                    path,
                    folderId: activeFolderId,
                    status: 'pending'
                }));
                setUploadQueue(prev => [...prev, ...newItems]);
                toast.info(`Queued ${kept.length} files for upload`);
            }
        } catch {
            toast.error("Failed to open file dialog");
        }
    };

    const handleFolderUpload = async () => {
        try {
            const selected = await open({ multiple: false, directory: true });
            if (!selected) return;
            const folderPath = Array.isArray(selected) ? selected[0] : selected;
            toast.info('Compressing folder...');
            try {
                const zipPath = await invoke<string>('cmd_zip_folder', { folderPath });
                const folderName = folderPath.split(/[/\\]/).pop() || 'folder';
                const newItem: QueueItem = {
                    id: Math.random().toString(36).substr(2, 9),
                    path: zipPath,
                    folderId: activeFolderId,
                    status: 'pending',
                };
                setUploadQueue(prev => [...prev, newItem]);
                toast.success(`Folder "${folderName}" compressed, queued for upload`);
            } catch (e) {
                toast.error(`Folder zip failed: ${e}`);
            }
        } catch {
            toast.error("Failed to open folder dialog");
        }
    };

    const handleRemoteUpload = (url: string) => {
        if (!url || !url.startsWith('http://') && !url.startsWith('https://')) {
            toast.error("Please enter a valid URL (http:// or https://)");
            return;
        }
        const newItem: QueueItem = {
            id: Math.random().toString(36).substr(2, 9),
            path: '',
            url,
            folderId: activeFolderId,
            status: 'pending',
            phase: 'downloading',
        };
        setUploadQueue(prev => [...prev, newItem]);
        toast.info(`Queued remote URL for upload`);
    };

    const cancelAll = () => {
        setUploadQueue(q => {
            const uploading = q.find(i => i.status === 'uploading');
            if (uploading) {
                cancelledRef.current.add(uploading.id);
                invoke('cmd_cancel_transfer', { transferId: uploading.id }).catch(() => {});
            }
            return q
                .filter(i => i.status !== 'pending')
                .map(i => i.status === 'uploading' ? { ...i, status: 'cancelled' as const } : i);
        });
        toast.info('All uploads cancelled');
    };

    const cancelItem = (id: string) => {
        setUploadQueue(q => {
            const item = q.find(i => i.id === id);
            if (item?.status === 'uploading') {
                cancelledRef.current.add(id);
                invoke('cmd_cancel_transfer', { transferId: id }).catch(() => {});
                return q.map(i => i.id === id ? { ...i, status: 'cancelled' as const } : i);
            }
            // Remove pending items directly
            if (item?.status === 'pending') {
                cleanupStagedTemp(item);
                return q.filter(i => i.id !== id);
            }
            return q;
        });
    };

    const retryItem = (id: string) => {
        setUploadQueue(q => q.map(i =>
            i.id === id && (i.status === 'error' || i.status === 'cancelled')
                ? { ...i, status: 'pending' as const, error: undefined, progress: undefined, uploadedBytes: undefined, totalBytes: undefined, speedBytesPerSec: undefined }
                : i
        ));
    };

    const { isDragging } = useFileDrop();

    const stageAndQueue = async (files: File[], limitBytes: number, hasFolder: boolean) => {
        const { stageDroppedFiles } = await import('./useDroppedFileUpload');
        const items = await stageDroppedFiles(files, activeFolderId, limitBytes, hasFolder);
        if (items.length > 0) {
            // Accidental double-drop of the same file(s): skip names already queued
            // or in flight, so one slip doesn't upload everything twice.
            const activeNames = new Set(
                queueMirrorRef.current
                    .filter(i => i.status === 'pending' || i.status === 'uploading')
                    .map(i => i.displayName),
            );
            const fresh = items.filter(it => !activeNames.has(it.displayName));
            const skipped = items.length - fresh.length;
            if (skipped > 0) toast.info(`Skipped ${skipped} duplicate file(s) already queued.`);
            if (fresh.length === 0) return;
            setUploadQueue(prev => [...prev, ...fresh]);
            toast.info(`Queued ${fresh.length} file(s) for upload`);
        }
    };

    return {
        uploadQueue,
        setUploadQueue,
        handleManualUpload,
        handleFolderUpload,
        handleRemoteUpload,
        stageAndQueue,
        cancelAll,
        cancelItem,
        retryItem,
        isDragging
    };
}
