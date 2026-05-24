import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Store } from '@tauri-apps/plugin-store';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useConfirm } from '../context/ConfirmContext';
import { TelegramFolder, ScanResult } from '../types';
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
                if (result.added.length > 0 || result.updated.length > 0 || result.removed.length > 0) {
                    showSyncSummary(result);
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
        isNetworkError,
        forceLogout
    };
}
