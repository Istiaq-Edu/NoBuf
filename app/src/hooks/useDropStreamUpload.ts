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

/**
 * Emit the nobuf-drop-done terminal event. Uses globalThis (not `window`) and
 * no-ops when CustomEvent is unavailable — this module's tests run in a plain
 * node vitest environment where neither exists, and an exception escaping
 * startOne's catch block surfaces as an unhandled rejection that fails CI.
 */
function emitDone(detail: { id: string; status: string; error?: string; messageId?: unknown }) {
    const G = globalThis as { dispatchEvent?: (e: unknown) => void; CustomEvent?: new (t: string, o: unknown) => unknown };
    if (!G.dispatchEvent || !G.CustomEvent) return;
    G.dispatchEvent(new G.CustomEvent('nobuf-drop-done', { detail }));
}

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
    //
    // Two-step classifier (assessment round 2):
    //   Step 1 — liveness: HEAD '/' resolves with ANY status => TCP+HTTP up.
    //     null => server down OR webview blocked it; cmd_get_stream_info().alive
    //     is the authoritative tiebreaker (Rust-side bind flag).
    //   Step 2 — route check only if alive: 405 = healthy; 404 = binary without
    //     the route (needs restart/update); anything else passes.
    try {
        const info = await getStreamInfo();
        const headStatus = (url: string) =>
            fetch(url, { method: 'HEAD' }).then(r => r.status).catch(() => null);
        // Normalize EVERYTHING to 127.0.0.1: the server binds IPv4-only, so any
        // request that resolves to ::1 talks to a different stack. Mixing
        // localhost/127.0.0.1 between probes is how two "different servers"
        // appear on one port.
        const rootUrl = info.base_url.replace('localhost', '127.0.0.1');
        const liveness = await headStatus(`${rootUrl}/`);
        console.info(`[drop] probe: HEAD / -> ${liveness ?? 'no-answer'}`);
        // Cross-check the Rust-side bind flag EVEN when liveness resolved: a
        // zombie previous instance can hold the port while THIS session's bind
        // failed — probing the zombie would end in 401s or a misleading
        // stale-binary toast instead of the real story.
        const aliveNow = await invoke<{ alive: boolean }>('cmd_get_stream_info');
        if (!aliveNow.alive) {
            throw new Error(liveness === null
                ? `streaming server not reachable (port ${info.base_url.split(':').pop()} did not bind)`
                : 'streaming port held by another NoBuf instance — close it and restart');
        }
        if (liveness === null) {
            throw new Error('webview blocked local requests');
        }
        const routeStatus = await headStatus(`${rootUrl}/upload-drop`);
        console.info(`[drop] probe: HEAD /upload-drop -> ${routeStatus ?? 'no-answer'}`);
        if (routeStatus === 404) {
            // Webview saw 404 — cross-check from the Rust side. If RUST also sees
            // 404, the router genuinely lacks the route. If Rust sees 405, the
            // webview's requests are being intercepted between it and the server.
            let rustView = 'probe-failed';
            try {
                rustView = String(await invoke<string>('cmd_probe_upload_route', { port: Number(info.base_url.split(':').pop()) }));
            } catch (pe) { rustView = String(pe); }
            console.info(`[drop] probe: Rust-side HEAD /upload-drop -> ${rustView}`);
            throw new Error(
                rustView.includes('405')
                    ? 'webview requests intercepted (Rust sees the route, webview gets 404)'
                    : 'direct-upload route missing — restart/update NoBuf');
        }
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
        void enqueueStart(id);
    }
    return items;
}

/**
 * Concurrency gate: ONE drop upload streams at a time, matching the original
 * upload system's sequential behavior. Parallel drops (each spawning 4
 * grammers workers) share one MTProto connection — under load a cancel or
 * network blip cascades os-error-10053 across every in-flight transfer.
 * Excess items wait in FIFO order and start automatically as slots free up.
 */
const MAX_PARALLEL_DROPS = 1;
let activeDrops = 0;
const pendingDrops: string[] = [];

function enqueueStart(id: string) {
    if (activeDrops < MAX_PARALLEL_DROPS) {
        dequeueStart(id);
    } else {
        pendingDrops.push(id);
    }
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
                    // Server errors are plain text (upload_drop.rs bodies); JSON is
                    // the fallback, not the rule. Parse must not swallow the real
                    // reason ("Daily bandwidth limit exceeded" etc).
                    let msg = `Server error ${xhr.status}`;
                    try {
                        const parsed = JSON.parse(xhr.responseText);
                        msg = parsed?.error ?? xhr.responseText ?? msg;
                    } catch {
                        msg = xhr.responseText || msg;
                    }
                    resolve({ ok: false, error: msg });
                }
            };
            xhr.send(file); // browser streams the File natively
        });

        // Terminal state handling mirrors processItem's semantics.
        if (result.ok) {
            emitDone({ id, status: 'success', messageId: undefined });
        } else if (result.error?.includes('ALREADY_STORED')) {
            // Bytes reached Telegram but the final send/resolve step failed —
            // the document exists server-side. Retrying would duplicate it.
            emitDone({ id, status: 'error', error: `File was uploaded but delivering it to the folder failed (it may exist in Telegram already). ${result.error}` });
            // Retire the handle: retry is intentionally NOT offered for this state.
            forgetLiveDrop(id);
        } else if (result.error?.includes('cancel')) {
            emitDone({ id, status: 'cancelled', error: result.error });
        } else {
            emitDone({ id, status: 'error', error: result.error });
        }
    } catch (e) {
        emitDone({ id, status: 'error', error: String(e) });
    } finally {
        activeXhrs.delete(id);
    }
}

/** User-facing cancel: aborts the XHR (server sees disconnect, stops uploading). */
export function cancelDropStream(id: string) {
    const xhr = activeXhrs.get(id);
    if (xhr) {
        xhr.abort();
        return;
    }
    // Not started yet (waiting in the concurrency-gate FIFO): mark it so
    // dequeueStart skips it — otherwise the "cancelled" row resurrects when
    // its turn comes. Same defect class as the Cancel-All leak.
    cancelledBeforeStart.add(id);
}

/** Ids cancelled while queued in the concurrency gate — never start these. */
const cancelledBeforeStart = new Set<string>();

function dequeueStart(id: string) {
    if (cancelledBeforeStart.delete(id)) return; // user cancelled while queued: stay dead
    activeDrops++;
    void startOne(id).finally(() => {
        activeDrops--;
        const next = pendingDrops.shift();
        if (next) dequeueStart(next);
    });
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
    // P1 fix (final sweep): a cancelled-while-queued id can sit in pendingDrops
    // MORE THAN ONCE if the user retries and cancels again before the slot
    // frees. Purge every stale occurrence plus the skip-marker so this retry
    // starts exactly once, from a clean slate.
    for (let i = pendingDrops.length - 1; i >= 0; i--) {
        if (pendingDrops[i] === item.id) pendingDrops.splice(i, 1);
    }
    cancelledBeforeStart.delete(item.id);
    // Route through the gate like a fresh drop — retry must not bypass the
    // concurrency cap, or a 20-file retry storm reopens the FLOOD_WAIT hole.
    void enqueueStart(item.id);
    return true;
}
