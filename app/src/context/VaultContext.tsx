import { createContext, useContext, useState, useEffect, useCallback, useMemo, ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useQueryClient } from '@tanstack/react-query';

/** Shape returned by cmd_vault_get_state. IDs are ALWAYS included (the
 *  backend's concealment gate lives in the search filter, not the response). */
export interface VaultState {
    has_passcode: boolean;
    is_unlocked: boolean;
    entry_visible: boolean;
    folder_count: number;
    public_count: number;
    chat_count: number;
    folder_ids: number[] | null;
    public_ids: number[] | null;
    chat_ids: number[] | null;
}

export type VaultKind = 'folder' | 'public_channel' | 'chat';

interface VaultContextValue {
    /** True once the first get_state resolves — gates restore logic (§4.3). */
    ready: boolean;
    isUnlocked: boolean;
    hasPasscode: boolean;
    entryVisible: boolean;
    folderCount: number;
    publicCount: number;
    chatCount: number;
    totalCount: number;
    /** Hidden IDs — ALWAYS present (the backend includes them while locked
     *  so the UI can conceal; see vault.rs state_response). */
    hiddenFolderIds: Set<number>;
    hiddenPublicIds: Set<number>;
    hiddenChatIds: Set<number>;
    refresh: () => Promise<VaultState>;
    hide: (kind: VaultKind, id: number) => Promise<void>;
    unhide: (kind: VaultKind, id: number) => Promise<void>;
    verify: (passcode: string) => Promise<boolean>;
    setPasscode: (passcode: string) => Promise<boolean>;
    changePasscode: (newPasscode: string) => Promise<boolean>;
    lock: () => Promise<void>;
    reset: () => Promise<void>;
    setEntryVisible: (visible: boolean) => Promise<void>;
}

const VaultContext = createContext<VaultContextValue | null>(null);

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests — bound to shipped code, spec §6)
// ---------------------------------------------------------------------------

/** Filter items whose id is hidden. Does NOT mutate the input array —
 *  persistence writers rely on receiving the full unfiltered array. */
export function filterHidden<T>(items: T[], getId: (item: T) => number, hidden: ReadonlySet<number>): T[] {
    if (hidden.size === 0) return items;
    return items.filter(item => !hidden.has(getId(item)));
}

/** Startup restore gate (spec §4.3): true when the persisted selection
 *  references a vaulted item in either scope. */
export function isVaultedSelection(
    id: number,
    hiddenFolderIds: ReadonlySet<number>,
    hiddenPublicIds: ReadonlySet<number>
): boolean {
    return hiddenFolderIds.has(id) || hiddenPublicIds.has(id);
}

/**
 * Public-channel prune diff (spec §4.4): channels present BEFORE a sync but
 * gone AFTER it were deleted from SQLite by the sync — they must be pruned
 * from the vault too, because nothing else tells vault.json about the delete.
 * Order-stable, idempotent, returns [] when nothing died.
 */
export function diffRemovedPublicIds(prevIds: number[], nextIds: number[]): number[] {
    const next = new Set(nextIds);
    return prevIds.filter(id => !next.has(id));
}



function applyState(
    state: VaultState,
    queryClient: ReturnType<typeof useQueryClient>
): void {
    // Cache hygiene (spec §4.2): when the vault just locked, hidden items'
    // cached listings must not stay reachable. Removing queries for ids we no
    // longer know about is impossible, so on LOCK we drop all per-item file
    // caches; they refetch on demand and non-vaulted views are unaffected
    // beyond one extra fetch.
    if (!state.is_unlocked) {
        queryClient.removeQueries({ queryKey: ['files'] });
        queryClient.removeQueries({ queryKey: ['publicChannelFiles'] });
        queryClient.removeQueries({ queryKey: ['chatFiles'] });
    }
}

export function VaultProvider({ children }: { children: ReactNode }) {
    const [ready, setReady] = useState(false);
    const [state, setState] = useState<VaultState | null>(null);
    const queryClient = useQueryClient();

    const apply = useCallback((s: VaultState) => {
        setState(s);
        applyState(s, queryClient);
        setReady(true);
    }, [queryClient]);

    const refresh = useCallback(async (): Promise<VaultState> => {
        const s = await invoke<VaultState>('cmd_vault_get_state');
        apply(s);
        return s;
    }, [apply]);

    useEffect(() => {
        // Backend owns lock truth; the context is a mirror that re-hydrates on
        // every mount (window reload / dev hot-reload re-syncs automatically).
        refresh().catch(() => {
            // Backend unreachable: stay locked-assumed, empty counts.
            setReady(true);
        });
        // Cross-device sync (spec §7): the launch-time pull in
        // useTelegramConnection broadcasts the post-sync state on this event.
        // Apply it so hidden channels appear without a restart.
        const onSyncedState = (e: Event) => {
            const s = (e as CustomEvent).detail as VaultState | undefined;
            if (s && typeof s === 'object' && 'is_unlocked' in s) {
                apply(s);
            }
        };
        window.addEventListener('nobuf-vault-state', onSyncedState);
        return () => window.removeEventListener('nobuf-vault-state', onSyncedState);
    }, [refresh, apply]);

    const hide = useCallback(async (kind: VaultKind, id: number) => {
        try {
            await invoke<VaultState>('cmd_vault_hide', { kind, id });
        } catch (e) {
            if (String(e).includes('passcode_required')) throw e;
            throw e;
        }
        await refresh();
        // Cross-device sync (best-effort, non-fatal).
        invoke('cmd_vault_push_sync').catch(() => {});
    }, [refresh]);

    const unhide = useCallback(async (kind: VaultKind, id: number) => {
        await invoke<VaultState>('cmd_vault_unhide', { kind, id });
        // Fresh data on next visit; nothing sensitive remains cached anyway.
        if (kind === 'folder') {
            queryClient.removeQueries({ queryKey: ['files', id] });
        } else if (kind === 'chat') {
            queryClient.removeQueries({ queryKey: ['chatFiles', id] });
        } else {
            queryClient.removeQueries({ queryKey: ['publicChannelFiles', id] });
        }
        await refresh();
        // Cross-device sync (best-effort, non-fatal).
        invoke('cmd_vault_push_sync').catch(() => {});
    }, [queryClient, refresh]);

    const verify = useCallback(async (passcode: string): Promise<boolean> => {
        try {
            const s = await invoke<VaultState>('cmd_vault_verify', { passcode });
            apply(s);
            return true;
        } catch {
            return false;
        }
    }, [apply]);

    const setPasscode = useCallback(async (passcode: string): Promise<boolean> => {
        try {
            const s = await invoke<VaultState>('cmd_vault_set_passcode', { passcode });
            apply(s);
            return true;
        } catch {
            return false;
        }
    }, [apply]);

    const changePasscode = useCallback(async (newPasscode: string): Promise<boolean> => {
        try {
            const s = await invoke<VaultState>('cmd_vault_change_passcode', { newPasscode });
            apply(s);
            // Cross-device sync (best-effort, non-fatal).
            invoke('cmd_vault_push_sync').catch(() => {});
            return true;
        } catch {
            return false;
        }
    }, [apply]);

    const lock = useCallback(async () => {
        const s = await invoke<VaultState>('cmd_vault_lock');
        apply(s);
    }, [apply]);

    const reset = useCallback(async () => {
        const s = await invoke<VaultState>('cmd_vault_reset');
        apply(s);
        // Cross-device sync (best-effort, non-fatal) — propagate reset to other PCs.
        invoke('cmd_vault_push_sync').catch(() => {});
    }, [apply]);

    const setEntryVisible = useCallback(async (visible: boolean) => {
        const s = await invoke<VaultState>('cmd_vault_set_entry_visible', { visible });
        apply(s);
    }, [apply]);

    // Stable Sets: consumers pass these into memo/effect dep arrays — fresh
    // Set objects every render would re-fire the restore gate and recompute
    // filtering on every unrelated Dashboard state change (bandwidth ticks
    // at 5s, selection clicks, search debounce). Recomputed only when the
    // underlying state actually changes.
    const hiddenFolderIds = useMemo(() => new Set(state?.folder_ids ?? []), [state?.folder_ids]);
    const hiddenPublicIds = useMemo(() => new Set(state?.public_ids ?? []), [state?.public_ids]);
    const hiddenChatIds = useMemo(() => new Set(state?.chat_ids ?? []), [state?.chat_ids]);

    const value: VaultContextValue = useMemo(() => ({
        ready: ready && state !== null,
        isUnlocked: state?.is_unlocked ?? false,
        hasPasscode: state?.has_passcode ?? false,
        entryVisible: state?.entry_visible ?? true,
        folderCount: state?.folder_count ?? 0,
        publicCount: state?.public_count ?? 0,
        chatCount: state?.chat_count ?? 0,
        totalCount: (state?.folder_count ?? 0) + (state?.public_count ?? 0) + (state?.chat_count ?? 0),
        hiddenFolderIds,
        hiddenPublicIds,
        hiddenChatIds,
        refresh,
        hide,
        unhide,
        verify,
        setPasscode,
        changePasscode,
        lock,
        reset,
        setEntryVisible,
    }), [ready, state, hiddenFolderIds, hiddenPublicIds, hiddenChatIds, refresh, hide, unhide, verify, setPasscode, changePasscode, lock, reset, setEntryVisible]);

    return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useVault(): VaultContextValue {
    const ctx = useContext(VaultContext);
    if (!ctx) throw new Error('useVault must be used within VaultProvider');
    return ctx;
}
