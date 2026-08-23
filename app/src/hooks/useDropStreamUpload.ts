import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import type { QueueItem } from '../types';

/**
 * Stream-direct upload for external file drops (B′).
 *
 * The webview POSTs the raw File to the local actix server's /upload-drop route,
 * which pumps it straight into Telegram via grammers' upload_stream. No %TEMP%
 * copy, no preparing phase. Progress arrives through the SAME upload-progress
 * event channel as regular uploads, so TransferPanel needs zero changes.
 */

interface StreamInfo {
    token: string;
    base_url: string;
    video_base_url: string;
}

let cachedStreamInfo: StreamInfo | null = null;

async function getStreamInfo(): Promise<StreamInfo> {
    if (!cachedStreamInfo) {
        cachedStreamInfo = await invoke<StreamInfo>('cmd_get_stream_info');
    }
    return cachedStreamInfo;
}

export interface DropUploadHandle {
    cancel: () => void;
    done: Promise<{ ok: boolean; error?: string }>;
}

/** In-memory registry of live drop uploads so Retry can find their File handles. */
interface LiveDrop {
    file: File;
    folderId: number | null;
    displayName: string;
}
const liveDrops = new Map<string, LiveDrop>();
const activeXhrs = new Map<string, XMLHttpRequest>();

/** Remove a finished/cancelled drop from the live registry (called on terminal state). */
export function forgetLiveDrop(id: string) {
    liveDrops.delete(id);
}

/**
 * Validate + stream-upload dropped files directly.
 * Mirrors stageDroppedFiles' rejection rules but skips ALL disk work.
 */
export async function streamDroppedFiles(
    files: File[],
    activeFolderId: number | null,
    limitBytes: number,
    hasFolder: boolean,
    /** Names already queued/uploading for THIS destination (dedupe, pre-XHR). */
    activeNames?: ReadonlySet<string>,
): Promise<QueueItem[]> {
    // 1. All-or-nothing folder rejection (same as staging path)
    if (hasFolder) {
        toast.error("Folders aren't supported — drop files only.");
        return [];
    }

    const valid: File[] = [];
    const emptyNames: string[] = [];
    const oversized: string[] = [];
    for (const f of files) {
        if (f.size === 0) { emptyNames.push(f.name); continue; }
        if (f.size > limitBytes) { oversized.push(f.name); continue; }
        valid.push(f);
    }
    const cap = (names: string[]) =>
        names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3} more` : '');
    if (emptyNames.length > 0) {
        const verb = emptyNames.length === 1 ? 'is' : 'are';
        toast.error(`${cap(emptyNames)} ${verb} empty and can't be uploaded.`);
    }
    if (oversized.length > 0) {
        const gb = Math.round(limitBytes / 1_000_000_000);
        const verb = oversized.length === 1 ? 'exceeds' : 'exceed';
        toast.error(`${cap(oversized)} ${verb} the ${gb} GB limit.`);
    }
    if (valid.length === 0) return [];

    // Dedupe BEFORE any XHR starts: a skipped duplicate must not become an
    // invisible orphaned upload. Caller passes the live queue's active keys.
    const deduped: File[] = [];
    const dupeNames: string[] = [];
    for (const f of valid) {
        const key = `${activeFolderId ?? 'root'}::${f.name}`;
        if (activeNames?.has(key)) { dupeNames.push(f.name); continue; }
        deduped.push(f);
    }
    if (dupeNames.length > 0) {
        toast.info(`Skipped ${dupeNames.length} duplicate file(s) already queued.`);
    }
    if (deduped.length === 0) return [];

    // Server availability probe BEFORE committing to stream-direct: if the actix
    // route isn't there (old binary, server failed to start), the caller falls
    // back to legacy %TEMP% staging instead of every drop failing.
    try {
        const info = await getStreamInfo();
        const probe = await fetch(`${info.base_url}/upload-drop`, { method: 'HEAD' }).catch(() => null);
        // 405 = route exists, wrong method (expected). 404 = old binary without
        // the route — must fall back too. null = connection failure.
        if (!probe || probe.status === 404) throw new Error('streaming server route unavailable');
    } catch (e) {
        // Visible, not silent: a mystery "Preparing" row with no explanation is
        // undiagnosable. This toast names the fallback and its cause.
        const reason = e instanceof Error ? e.message : String(e);
        toast.info(`Direct-stream unavailable (${reason}) — using temp-staging upload.`);
        console.warn('[drop] stream-direct unavailable, falling back to staging:', e);
        throw e; // stageAndQueue catches this and uses the staging path
    }

    // Enqueue immediately with status 'uploading' — bytes start flowing right away
    // and progress events arrive via upload-progress listeners already wired in
    // useFileUpload. The QueueItem.path is a synthetic marker; cmd_upload_file is
    // never called for these items (processItem must skip them — see marker below).
    const items: QueueItem[] = [];
    for (const f of deduped) {
        const id = `drop-${Math.random().toString(36).slice(2, 11)}`;
        liveDrops.set(id, { file: f, folderId: activeFolderId, displayName: f.name });
        items.push({
            id,
            path: `nobuf-drop-stream://${encodeURIComponent(f.name)}`,
            folderId: activeFolderId,
            status: 'uploading',
            progress: 0,
            displayName: f.name,
        });
        void startOne(id);
    }
    return items;
}

async function startOne(id: string) {
    const entry = liveDrops.get(id);
    if (!entry) return;
    // Double-retry guard: a second XHR with the same tid would duplicate the
    // Telegram document, and activeXhrs.set overwrite would orphan the first.
    if (activeXhrs.has(id)) return;
    const { file, folderId, displayName } = entry;

    try {
        const info = await getStreamInfo();
        const params = new URLSearchParams({
            token: info.token, // session token: the route rejects unauthenticated POSTs
            name: file.name,
            size: String(file.size),
            display_name: displayName,
            folder_id: folderId === null ? '' : String(folderId),
            tid: id,
        });
        const xhr = new XMLHttpRequest();
        activeXhrs.set(id, xhr);

        const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
            xhr.open('POST', `${info.base_url}/upload-drop?${params.toString()}`, true);
            xhr.timeout = 0; // no timeout: large uploads over slow links are legal
            xhr.onerror = () => resolve({ ok: false, error: 'Network error talking to the local server' });
            xhr.onabort = () => resolve({ ok: false, error: 'Transfer cancelled' });
            xhr.onload = () => {
                if (xhr.status === 200) {
                    resolve({ ok: true });
                } else {
                    let msg = `Server error ${xhr.status}`;
                    try { msg = JSON.parse(xhr.responseText)?.error ?? xhr.responseText ?? msg; } catch { /* raw */ }
                    resolve({ ok: false, error: msg });
                }
            };
            xhr.send(file); // browser streams the File natively
        });

        // Terminal state handling mirrors processItem's semantics.
        if (result.ok) {
            window.dispatchEvent(new CustomEvent('nobuf-drop-done', {
                detail: { id, status: 'success', messageId: undefined },
            }));
        } else if (result.error?.includes('cancel')) {
            window.dispatchEvent(new CustomEvent('nobuf-drop-done', {
                detail: { id, status: 'cancelled', error: result.error },
            }));
        } else {
            window.dispatchEvent(new CustomEvent('nobuf-drop-done', {
                detail: { id, status: 'error', error: result.error },
            }));
        }
    } catch (e) {
        window.dispatchEvent(new CustomEvent('nobuf-drop-done', {
            detail: { id, status: 'error', error: String(e) },
        }));
    } finally {
        activeXhrs.delete(id);
    }
}

/** User-facing cancel: aborts the XHR (server sees disconnect, stops uploading). */
export function cancelDropStream(id: string) {
    activeXhrs.get(id)?.abort();
}

/**
 * Retry a failed/cancelled stream-direct drop using its retained File handle.
 * Returns null when the handle is gone (shouldn't happen within a session).
 */
export function retryDropStream(item: QueueItem): boolean {
    if (!item.path.startsWith('nobuf-drop-stream://')) return false;
    if (!liveDrops.has(item.id)) {
        toast.error('Source file handle lost — drop the file again.');
        return true; // handled (as failure)
    }
    void startOne(item.id);
    return true;
}
