/**
 * useDroppedFileUpload — validation + chunked staging for external file drops.
 *
 * External OS drops arrive as browser File objects (Tauri native drag-drop handler is
 * disabled). We stream each file's bytes chunk-by-chunk to the Rust `cmd_stage_dropped_file`
 * command (never holding a whole file in RAM), which writes a temp file and returns its path.
 * The path is then queued through the EXISTING cmd_upload_file pipeline (progress/cancel/bandwidth).
 */
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { QueueItem } from '../types';

const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB — never hold the whole file in RAM

async function stageOne(file: File, id: string): Promise<string> {
    const total = file.size;
    let offset = 0;
    let chunkIndex = 0;
    let tempPath = '';
    do {
        const end = Math.min(offset + CHUNK_SIZE, total);
        const buf = new Uint8Array(await file.slice(offset, end).arrayBuffer());
        const isLast = end >= total;
        tempPath = await invoke<string>('cmd_stage_dropped_file', {
            uploadId: id,
            fileName: file.name,
            chunkIndex,
            isLast,
            bytes: Array.from(buf), // Tauri deserializes Vec<u8> from a number array
        });
        offset = end;
        chunkIndex += 1;
    } while (offset < total);
    return tempPath;
}

/**
 * Validate + stage dropped files. Returns QueueItems ready to enqueue.
 * Rejections (folders / empty / oversized / unreadable) are surfaced as toasts here.
 *
 * `hasFolder` MUST be computed synchronously at the drop site via
 * DataTransferItem.webkitGetAsEntry().isDirectory — a dropped folder still appears in
 * dataTransfer.files as a zero-byte File, so it can only be reliably distinguished from a
 * genuinely empty file at drop time, before the items list is neutralized by any await.
 */
export async function stageDroppedFiles(
    files: File[],
    activeFolderId: number | null,
    limitBytes: number,
    hasFolder: boolean,
): Promise<QueueItem[]> {
    // 1. All-or-nothing folder rejection
    if (hasFolder) {
        toast.error("Folders aren't supported — drop files only.");
        return [];
    }
    // 2/3. Filter empty + oversized
    const valid: File[] = [];
    let emptyCount = 0;
    const oversized: string[] = [];
    for (const f of files) {
        if (f.size === 0) { emptyCount += 1; continue; }
        if (f.size > limitBytes) { oversized.push(f.name); continue; }
        valid.push(f);
    }
    if (emptyCount > 0) toast.error(`Skipped ${emptyCount} empty file(s).`);
    if (oversized.length > 0) {
        const gb = Math.round(limitBytes / 1_000_000_000);
        toast.error(`${oversized.length} file(s) exceed the ${gb} GB limit.`);
    }
    if (valid.length === 0) return [];

    // 4/5. Stage each survivor → QueueItem
    const items: QueueItem[] = [];
    for (const f of valid) {
        const id = Math.random().toString(36).substr(2, 9);
        try {
            const tempPath = await stageOne(f, id);
            if (tempPath) items.push({ id, path: tempPath, folderId: activeFolderId, status: 'pending' });
        } catch (e) {
            toast.error(`Couldn't read ${f.name}: ${e}`);
        }
    }
    return items;
}
