import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { forgetLiveDrop, cancelDropStream, retryDropStream } from './useDropStreamUpload';
import { QueueItem } from '../types';

/** True when a queue item is a stream-direct drop (never touches cmd_upload_file). */
export function isDropStreamItem(item: Pick<QueueItem, 'path'>): boolean {
    return item.path.startsWith('nobuf-drop-stream://');
}
import { useFileDrop } from './useFileDrop';
import { useSplitUpload } from './useSplitUpload';
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

    // Stream-direct drops report their own terminal states (success / cancelled /
    // error) via the nobuf-drop-done event from useDropStreamUpload. Progress
    // arrives through the regular upload-progress channel — no extra wiring.
    useEffect(() => {
        const onDropDone = (e: Event) => {
            const { id, status, error } = (e as CustomEvent).detail as {
                id: string; status: 'success' | 'cancelled' | 'error'; error?: string;
            };
            setUploadQueue(q => q.map(i => i.id === id ? {
                ...i,
                status: status as QueueItem['status'],
                progress: status === 'success' ? 100 : undefined,
                // Drop the stale byte counters too — otherwise error/cancel rows
                // keep showing a frozen "X / Y" from the last progress event.
                uploadedBytes: status === 'success' ? i.uploadedBytes : undefined,
                totalBytes: status === 'success' ? i.totalBytes : undefined,
                speedBytesPerSec: undefined,
                error,
            } : i));
            const item = queueMirrorRef.current.find(i => i.id === id);
            if (status === 'success') {
                queryClient.invalidateQueries({ queryKey: ['files', item?.folderId] });
            }
            // Keep the File handle for error/cancel: Retry re-streams from it.
            // Only success retires it.
            if (status === 'success') forgetLiveDrop(id);
        };
        window.addEventListener('nobuf-drop-done', onDropDone);
        return () => window.removeEventListener('nobuf-drop-done', onDropDone);
    }, [queryClient]);

    const processItem = async (item: QueueItem) => {
        // Stream-direct drops manage their own lifecycle (XHR + server events);
        // they enter the queue as 'uploading' and must never hit cmd_upload_file.
        if (isDropStreamItem(item)) return;
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
                // Cancel keeps the staged temp file: the item stays retryable, and
                // Retry re-uploads from it. Deleted on success or queue removal.
                cancelledRef.current.delete(item.id);
            } else {
                setUploadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'success', progress: 100 } : i));
                cleanupStagedTemp(item);
                queryClient.invalidateQueries({ queryKey: ['files', item.folderId] });
            }
        } catch (e) {
            if (!cancelledRef.current.has(item.id)) {
                const errMsg = String(e);
                if (errMsg.includes('Transfer cancelled')) {
                    // Cancelled mid-upload: keep temp (item stays retryable).
                    setUploadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'cancelled' } : i));
                } else {
                    // Terminal error keeps the staged temp file so Retry can re-upload it.
                    setUploadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'error', error: errMsg } : i));
                    toast.error(`Upload failed for ${item.displayName || item.path.split('/').pop()}: ${e}`);
                }
            } else {
                // Cancelled (item marked by cancelItem): keep temp (retryable).
                cancelledRef.current.delete(item.id);
            }
        } finally {
            setProcessing(false);
        }
    };

    const splitFlow = useSplitUpload();

    const handleManualUpload = async () => {
        try {
            const selected = await open({ multiple: true, directory: false });
            if (selected) {
                const paths = Array.isArray(selected) ? selected : [selected];
                // Pre-validate against the Premium-aware size limit (consistent with drop path).
                const VIDEO_RE = /\.(mp4|m4v|mov|mkv|avi|webm|wmv|flv|ts|m2ts|mpg|mpeg)$/i;
                const kept: string[] = [];
                const oversizedNames: string[] = [];
                let splitCandidate: string | null = null;
                for (const p of paths) {
                    try {
                        const size = await invoke<number>('cmd_file_size', { path: p });
                        if (size > limitBytes) {
                            const name = p.split(/[/\\]/).pop() || p;
                            if (VIDEO_RE.test(name)) {
                                // First oversize video opens the split screen; extra ones rejected.
                                if (!splitCandidate) splitCandidate = p;
                                else oversizedNames.push(name);
                            } else {
                                oversizedNames.push(name);
                            }
                            continue;
                        }
                    } catch { /* if size probe fails, let the upload flow surface the error */ }
                    kept.push(p);
                }
                if (oversizedNames.length > 0) {
                    const gb = Math.round(limitBytes / 1_000_000_000);
                    // Name the files (spec §3.3 style), matching the drop path's wording.
                    const names = oversizedNames.slice(0, 3).join(', ') + (oversizedNames.length > 3 ? ` +${oversizedNames.length - 3} more` : '');
                    toast.error(`${names} ${oversizedNames.length === 1 ? 'exceeds' : 'exceed'} the ${gb} GB limit.`);
                }
                if (splitCandidate) {
                    splitFlow.prepare(splitCandidate, activeFolderId);
                }
                if (kept.length > 0) {
                    const newItems: QueueItem[] = kept.map((path: string) => ({
                        id: Math.random().toString(36).substr(2, 9),
                        path,
                        folderId: activeFolderId,
                        status: 'pending'
                    }));
                    setUploadQueue(prev => [...prev, ...newItems]);
                    toast.info(`Queued ${kept.length} files for upload`);
                }
                if (kept.length === 0 && !splitCandidate) return;
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
        // Bulk-cancel removes pending items permanently (no Retry), so their staged
        // temp files must go with them — same as cancelItem's pending path.
        // Read from the mirror OUTSIDE the updater: updaters must stay pure.
        queueMirrorRef.current
            .filter(i => i.status === 'pending' && i.stagedTempPath)
            .forEach(i => cleanupStagedTemp(i));
        // Stream-direct drops abort via their XHRs; every marker must be hit or
        // its upload keeps streaming and resurrects the row on completion.
        queueMirrorRef.current
            .filter(i => i.status === 'uploading' && isDropStreamItem(i))
            .forEach(i => cancelDropStream(i.id));
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
            // Stream-direct drops: abort the XHR; server sees disconnect and stops.
            if (item?.path.startsWith('nobuf-drop-stream://')) {
                cancelDropStream(id);
                return q.map(i => i.id === id ? { ...i, status: 'cancelled' as const } : i);
            }
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
            // Bulk-cancelled pending items (cancelAll) are removed by its filter,
            // which must not leave their staged temp files behind either.
            return q;
        });
    };

    const retryItem = (id: string) => {
        // Stream-direct drops retry from their retained in-memory File handle.
        const item = queueMirrorRef.current.find(i => i.id === id);
        if (item && isDropStreamItem(item)) {
            // retryDropStream returns false when the handle is gone — then leave
            // the row as-is (error state) instead of creating a phantom upload.
            if (!retryDropStream(item)) return;
            setUploadQueue(q => q.map(i =>
                i.id === id ? { ...i, status: 'uploading' as const, progress: 0, error: undefined } : i
            ));
            return;
        }
        setUploadQueue(q => q.map(i =>
            i.id === id && (i.status === 'error' || i.status === 'cancelled')
                ? { ...i, status: 'pending' as const, error: undefined, progress: undefined, uploadedBytes: undefined, totalBytes: undefined, speedBytesPerSec: undefined }
                : i
        ));
    };

    const { isDragging } = useFileDrop();

    const stageAndQueue = async (files: File[], limitBytes: number, hasFolder: boolean,
        onStagingProgress?: (fileName: string, pct: number) => void) => {
        // B′: dropped files stream DIRECTLY to Telegram over the local actix
        // server — no %TEMP% staging, no preparing phase. Falls back to the old
        // staging path when the availability probe in streamDroppedFiles throws
        // (server down / route absent).
        try {
            const { streamDroppedFiles } = await import('./useDropStreamUpload');
            // Dedupe keys computed BEFORE the call: streamDroppedFiles skips
            // duplicates pre-XHR (a skipped file must not become an orphaned
            // upload) and throws when the server route is unavailable → legacy
            // staging below.
            const activeKeys = new Set(
                queueMirrorRef.current
                    .filter(i => i.status === 'pending' || i.status === 'uploading')
                    .map(i => `${i.folderId ?? 'root'}::${i.displayName}`),
            );
            const items = await streamDroppedFiles(files, activeFolderId, limitBytes, hasFolder, activeKeys);
            if (items.length > 0) {
                setUploadQueue(prev => [...prev, ...items]);
            }
            return;
        } catch (e) {
            console.warn('[drop] stream-direct unavailable, falling back to staging:', e);
            // fall through to legacy staging path below
        }
        const { stageDroppedFiles } = await import('./useDroppedFileUpload');
        const items = await stageDroppedFiles(files, activeFolderId, limitBytes, hasFolder, onStagingProgress);
        if (items.length > 0) {
            // Accidental double-drop of the same file(s): skip names already queued
            // or in flight FOR THE SAME DESTINATION. The same file into a different
            // folder is a legitimate second upload, not a duplicate.
            const activeKeys = new Set(
                queueMirrorRef.current
                    .filter(i => i.status === 'pending' || i.status === 'uploading')
                    .map(i => `${i.folderId ?? 'root'}::${i.displayName}`),
            );
            const fresh = items.filter(it => !activeKeys.has(`${it.folderId ?? 'root'}::${it.displayName}`));
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
        isDragging,
        splitFlow
    };
}
