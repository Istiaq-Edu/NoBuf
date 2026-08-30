import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Store } from '@tauri-apps/plugin-store';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useConfirm } from '../context/ConfirmContext';
import { TelegramFolder, ScanResult } from '../types';
import { diffRemovedPublicIds } from '../context/VaultContext';
import { useNetworkStatus } from './useNetworkStatus';

export function useTelegramConnection(onLogoutParent: () => void) {
    const queryClient = useQueryClient();
    const { confirm } = useConfirm();

    const [folders, setFolders] = useState<TelegramFolder[]>([]);
    const [activeFolderId, setActiveFolderId] = useState<number | null>(null);
    const [store, setStore] = useState<Store | null>(null);
    const [isSyncing, setIsSyncing] = useState(false);
    const [isConnected, setIsConnected] = useState(true);
    const autoSyncDone = useRef(false);
    // F19: post-first-scan folder list — the startup rescan must diff against
    // THIS, not the stale `folders` closure (which still holds the pre-scan list).
    const rescanBaseline = useRef<TelegramFolder[]>([]);

    const networkIsOnline = useNetworkStatus();

    // Load persisted store and restore saved folders.
    useEffect(() => {
        const initStore = async () => {
            try {
                let _store = await Store.load('config.json');
                const checkId = await _store.get<string>('api_id');
                if (!checkId) {
                    _store = await Store.load('settings.json');
                }
                setStore(_store);

                const savedFolders = await _store.get<TelegramFolder[]>('folders');
                if (savedFolders) setFolders(savedFolders);

                const savedActiveFolderId = await _store.get<number | null>('activeFolderId');
                if (savedActiveFolderId !== undefined) setActiveFolderId(savedActiveFolderId);

                setIsConnected(true);
                queryClient.invalidateQueries({ queryKey: ['files'] });
            } catch {
                // store not available
            }
        };
        initStore();
    }, [queryClient]);

    // Startup auto-sync: run once after dashboard loads and connection is live
    useEffect(() => {
        if (!store || autoSyncDone.current || !isConnected) return;
        autoSyncDone.current = true;

        const doAutoSync = async () => {
            setIsSyncing(true);
            try {
                const result = await invoke<ScanResult>('cmd_start_auto_sync', { localFolders: folders });
                applySyncResult(result);
                // F19: record the post-first-scan baseline for the rescan below.
                rescanBaseline.current = result.current ?? [];
                // Vault prune (spec §4.4): drop dead folder ids from vault.json.
                // Works while locked; intersection-only on the backend.
                if (result.removed.length > 0) {
                    try {
                        await invoke('cmd_vault_prune', { kind: 'folder', ids: result.removed });
                    } catch {
                        // Non-fatal: stale id survives until next sync.
                    }
                }
                // Sync public channels from [NB-PUB]
                try {
                    const prevPublicIds = (await invoke<any[]>('cmd_get_public_channels')).map((c: any) => c.channel_id);
                    // F15: capture the adopted set BEFORE sync — the (expensive)
                    // rescan below only runs when sync actually landed NEW
                    // adoptions, instead of on every launch.
                    const prevAdoptedIds = new Set(
                        (await invoke<any[]>('cmd_get_adopted_folders').catch(() => [] as any[]))
                            .map((r: any) => r.channel_id)
                    );
                    await invoke('cmd_sync_public_channels');
                    // The sync command rewrote SQLite behind React Query's back;
                    // invalidate so the sidebar reflects the reconciled list NOW
                    // instead of showing the pre-sync snapshot until an
                    // unrelated refetch.
                    queryClient.invalidateQueries({ queryKey: ['publicChannels'] });
                    // Public-channel pruning: SQLite sync deletes dead rows but
                    // never tells the vault — diff previous vs new and prune.
                    const nextPublic = await invoke<any[]>('cmd_get_public_channels');
                    const gone = diffRemovedPublicIds(prevPublicIds, nextPublic.map((c: any) => c.channel_id));
                    if (gone.length > 0) {
                        try {
                            await invoke('cmd_vault_prune', { kind: 'public_channel', ids: gone });
                        } catch {
                            // Non-fatal: stale id survives until next sync.
                        }
                    }
                    // NB-PUB sync may have landed NEW adoption records in SQLite
                    // AFTER the folder scan above already ran (startup ordering:
                    // scan → public-channel sync). Re-scan ONLY when the adopted
                    // set grew (plan QA 8b) — a full dialog walk on every launch
                    // doubles the FLOOD_WAIT surface for nothing.
                    const nextAdopted = await invoke<any[]>('cmd_get_adopted_folders').catch(() => [] as any[]);
                    const grew = nextAdopted.some((r: any) => !prevAdoptedIds.has(r.channel_id));
                    if (grew) {
                        try {
                            // F19: diff against the FIRST scan's result.current —
                            // `folders` in this closure is the pre-sync list, so
                            // the rescan would re-report the first scan's changes.
                            const rescan = await invoke<ScanResult>('cmd_start_auto_sync', { localFolders: rescanBaseline.current });
                            applySyncResult(rescan);
                            if (rescan.added.length > 0 || rescan.updated.length > 0) {
                                showSyncSummary(rescan);
                            }
                            if (rescan.removed.length > 0) {
                                try {
                                    await invoke('cmd_vault_prune', { kind: 'folder', ids: rescan.removed });
                                } catch { /* non-fatal */ }
                            }
                        } catch {
                            // Non-fatal: adopted folders surface on the next manual sync.
                        }
                    }
                } catch (e) {
                    console.warn('[Public Channels] Sync failed:', e);
                }
                if (result.added.length > 0 || result.updated.length > 0 || result.removed.length > 0) {
                    showSyncSummary(result);
                }
                // Vault cross-device sync (spec §7): pull once per launch.
                // Merges hidden-ID lists + passcode from Saved Messages.
                // The response carries the post-sync state — hand it to the
                // app via a re-emitted event so the UI applies it NOW
                // (previously the merged state was discarded until restart).
                try {
                    const result = await invoke<{ merged: boolean; state: unknown }>('cmd_vault_pull_sync');
                    window.dispatchEvent(new CustomEvent('nobuf-vault-state', { detail: result.state }));
                } catch {
                    // Non-fatal: offline / not connected yet.
                }
            } catch {
                // Silent failure for auto-sync — don't disrupt user
            } finally {
                setIsSyncing(false);
            }
        };
        doAutoSync();
    }, [store, isConnected]);

    useEffect(() => {
        setIsConnected(networkIsOnline);
    }, [networkIsOnline]);

    // Apply a ScanResult to the local folder state and persist to store
    const applySyncResult = useCallback((result: ScanResult) => {
        setFolders(prev => {
            let updated = [...prev];

            // Add new folders
            for (const f of result.added) {
                if (!updated.find(existing => existing.id === f.id)) {
                    updated.push(f);
                }
            }

            // Update names for changed folders
            for (const f of result.updated) {
                const idx = updated.findIndex(existing => existing.id === f.id);
                if (idx !== -1) {
                    updated[idx] = { ...updated[idx], name: f.name };
                }
            }

            // Remove stale folders
            updated = updated.filter(f => !result.removed.includes(f.id));

            // Persist
            if (store) {
                store.set('folders', updated).then(() => store.save());
            }

            // Handle active folder removal
            if (result.removed.length > 0) {
                const currentActive = activeFolderId;
                if (currentActive !== null && result.removed.includes(currentActive)) {
                    setActiveFolderId(null);
                    if (store) {
                        store.set('activeFolderId', null).then(() => store.save());
                    }
                    toast.info("Current folder was removed on Telegram — redirected to Saved Messages.");
                }
            }

            return updated;
        });
    }, [store, activeFolderId]);

    // Show detailed sync summary toast
    const showSyncSummary = useCallback((result: ScanResult) => {
        const parts: string[] = [];
        if (result.added.length > 0) parts.push(`${result.added.length} new folder(s)`);
        if (result.updated.length > 0) parts.push(`${result.updated.length} name updated`);
        if (result.removed.length > 0) parts.push(`${result.removed.length} removed`);
        toast.success(`Sync complete: ${parts.join(', ')}`);
    }, []);

    const isNetworkError = (error: string): boolean => {
        const keywords = ['timeout', 'connection', 'network', 'socket', 'disconnected', 'EOF', 'ECONNREFUSED', 'overflow'];
        return keywords.some(k => error.toLowerCase().includes(k.toLowerCase()));
    };

    const forceLogout = async () => {
        setIsConnected(false);
        try {
            await invoke('cmd_clean_cache').catch(() => { });
            // Vault logout hygiene (spec rev 4): clear both hidden-ID lists,
            // keep the passcode, re-lock. Backend-side because the frontend
            // cannot know the IDs while locked (by design).
            try { await invoke('cmd_vault_wipe_ids'); } catch { /* best effort */ }
            if (store) {
                await store.delete('api_id');
                await store.delete('api_hash');
                await store.delete('folders');
                await store.save();
            }
        } catch {
            // best effort cleanup
        }
        toast.error("Connection lost. Please log in again.");
        onLogoutParent();
    };

    const handleLogout = async () => {
        if (!await confirm({ title: "Sign Out", message: "Are you sure you want to sign out? This will disconnect your active session.", confirmText: "Sign Out", variant: 'danger' })) return;

        try {
            await invoke('cmd_logout');
            await invoke('cmd_clean_cache');
            if (store) {
                await store.delete('api_id');
                await store.delete('api_hash');
                await store.delete('folders');
                await store.save();
            }
            onLogoutParent();
        } catch {
            toast.error("Error signing out");
            onLogoutParent();
        }
    };

    // Full reconciliation sync (manual button)
    const handleSyncFolders = async () => {
        if (!store) return;
        setIsSyncing(true);
        try {
            const result = await invoke<ScanResult>('cmd_scan_folders', { localFolders: folders });
            applySyncResult(result);
            showSyncSummary(result);
        } catch {
            toast.error("Sync failed");
        } finally {
            setIsSyncing(false);
        }
    };

    const handleCreateFolder = async (name: string) => {
        if (!store) return;
        try {
            const newFolder = await invoke<TelegramFolder>('cmd_create_folder', { name });
            const updated = [...folders, newFolder];
            setFolders(updated);
            await store.set('folders', updated);
            await store.save();
            toast.success(`Folder "${name}" created.`);
        } catch (e) {
            toast.error("Failed to create folder: " + e);
            throw e;
        }
    };

    // Rename folder — updates Telegram and local state
    const handleFolderRename = async (folderId: number, newName: string) => {
        if (!store) return;
        try {
            const updatedFolder = await invoke<TelegramFolder>('cmd_rename_folder', { folderId, newName });
            setFolders(prev => {
                const updated = prev.map(f =>
                    f.id === folderId ? { ...f, name: updatedFolder.name } : f
                );
                store.set('folders', updated).then(() => store.save());
                return updated;
            });
            toast.success(`Folder renamed to "${updatedFolder.name}".`);
        } catch (e) {
            toast.error("Failed to rename folder: " + e);
        }
    };

    // Delete folder — with warning about Telegram deletion
    const handleFolderDelete = async (folderId: number, folderName: string) => {
        if (!await confirm({
            title: "Delete Folder",
            message: `Are you sure you want to delete "${folderName}"?\nThis will permanently delete the channel on Telegram and all its files.`,
            confirmText: "Delete",
            variant: 'danger'
        })) return;

        try {
            await invoke('cmd_delete_folder', { folderId });
            const updated = folders.filter(f => f.id !== folderId);
            setFolders(updated);
            if (store) {
                await store.set('folders', updated);
                await store.save();
            }
            if (activeFolderId === folderId) {
                setActiveFolderId(null);
                if (store) {
                    await store.set('activeFolderId', null);
                    await store.save();
                }
            }
            toast.success(`Folder "${folderName}" deleted.`);
        } catch (e: unknown) {
            const errStr = String(e);
            if (errStr.includes("not found") || errStr.includes("No access hash") || errStr.includes("CHANNEL_PRIVATE")) {
                // Channel already gone on Telegram — just remove locally
                if (await confirm({
                    title: "Folder Not Found",
                    message: `"${folderName}" no longer exists on Telegram (may have been deleted externally).\nRemove from this app?`,
                    confirmText: "Remove",
                    variant: 'info'
                })) {
                    const updated = folders.filter(f => f.id !== folderId);
                    setFolders(updated);
                    if (store) {
                        await store.set('folders', updated);
                        await store.save();
                    }
                    if (activeFolderId === folderId) {
                        setActiveFolderId(null);
                        if (store) {
                            await store.set('activeFolderId', null);
                            await store.save();
                        }
                    }
                }
            } else {
                toast.error(`Failed to delete folder: ${e}`);
            }
        }
    };

    // Reorder folders — persists new order to store
    const handleFolderReorder = useCallback(async (reordered: TelegramFolder[]) => {
        setFolders(reordered);
        if (store) {
            await store.set('folders', reordered);
            await store.save();
        }
    }, [store]);

    // Adopt an owned/administered channel as a full folder. The backend returns
    // the FolderMetadata; we push it into folders state DIRECTLY (the
    // handleCreateFolder pattern) so the folder appears immediately — the
    // AddChannelModal's onAdded only invalidates ['publicChannels'].
    const handleAdoptChannel = useCallback(async (channelId: number, accessHash: number): Promise<TelegramFolder | null> => {
        if (!store) return null;
        try {
            const folder = await invoke<TelegramFolder>('cmd_adopt_channel', { channelId, accessHash });
            setFolders(prev => {
                const updated = prev.some(f => f.id === folder.id)
                    ? prev.map(f => f.id === folder.id ? folder : f)
                    : [...prev, folder];
                store.set('folders', updated).then(() => store.save());
                return updated;
            });
            toast.success(`"${folder.name}" added as a NoBuf folder.`);
            return folder;
        } catch (e) {
            const err = String(e);
            if (err.startsWith('ALREADY_ADOPTED')) {
                toast.info('This channel is already a NoBuf folder.');
            } else if (err.startsWith('NOT_ELIGIBLE')) {
                toast.error('Only channels you created or administer (with post permission) can be added as folders.');
            } else {
                toast.error('Failed to add channel: ' + e);
            }
            return null;
        }
    }, [store]);

    // Unadopt: remove the adoption record; the Telegram channel and its
    // subscribers are untouched. Also pushes the updated adoption list to
    // [NB-PUB] (fire-and-forget, same pattern as public-channel mutations).
    const handleUnadoptChannel = useCallback(async (folderId: number, folderName: string) => {
        if (!await confirm({
            title: "Remove from NoBuf",
            message: `Remove "${folderName}" from NoBuf?\nThe channel stays on Telegram with all its subscribers — only the folder disappears here.`,
            confirmText: "Remove",
            variant: 'info'
        })) return;
        if (!store) return;
        try {
            await invoke('cmd_unadopt_channel', { channelId: folderId });
            invoke('cmd_update_nb_pub_sync').catch(() => { /* local-only until next upload */ });
            const updated = folders.filter(f => f.id !== folderId);
            setFolders(updated);
            await store.set('folders', updated);
            await store.save();
            if (activeFolderId === folderId) {
                setActiveFolderId(null);
                await store.set('activeFolderId', null);
                await store.save();
            }
            toast.success(`"${folderName}" removed from NoBuf. The channel stays on Telegram.`);
        } catch (e) {
            toast.error('Failed to remove folder: ' + e);
        }
    }, [store, folders, activeFolderId, confirm]);

    // Permanently delete the underlying Telegram channel (adopted folders only,
    // gated behind a stronger danger dialog in the UI).
    const handleDeleteChannelPermanently = useCallback(async (folderId: number, accessHash: number, folderName: string) => {
        if (!await confirm({
            title: "Delete Channel Permanently",
            message: `This will PERMANENTLY DELETE "${folderName}" from Telegram — the channel, its subscribers, and every file in it.\n\nThis cannot be undone. To only remove it from NoBuf, use "Remove from NoBuf" instead.`,
            confirmText: "Delete Channel Forever",
            variant: 'danger'
        })) return;
        try {
            await invoke('cmd_delete_channel_permanently', { channelId: folderId, accessHash });
            invoke('cmd_update_nb_pub_sync').catch(() => { });
            const updated = folders.filter(f => f.id !== folderId);
            setFolders(updated);
            if (store) {
                await store.set('folders', updated);
                await store.save();
            }
            if (activeFolderId === folderId) {
                setActiveFolderId(null);
                if (store) {
                    await store.set('activeFolderId', null);
                    await store.save();
                }
            }
            toast.success(`"${folderName}" and its channel were permanently deleted.`);
        } catch (e) {
            toast.error('Failed to delete channel: ' + e);
        }
    }, [store, folders, activeFolderId, confirm]);

    const handleSetActiveFolderId = async (id: number | null) => {
        setActiveFolderId(id);
        if (store) {
            await store.set('activeFolderId', id);
            await store.save();
        }
    };

    return {
        store,
        folders,
        activeFolderId,
        setActiveFolderId: handleSetActiveFolderId,
        isSyncing,
        isConnected,
        handleLogout,
        handleSyncFolders,
        handleCreateFolder,
        handleFolderRename,
        handleFolderDelete,
        handleFolderReorder,
        handleAdoptChannel,
        handleUnadoptChannel,
        handleDeleteChannelPermanently,
        isNetworkError,
        forceLogout
    };
}
