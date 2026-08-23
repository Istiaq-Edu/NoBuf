import { useState, useEffect, useCallback, useRef } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';

import { TelegramFile, BandwidthStats } from '../types';
import { formatBytes, isMediaFile, isPdfFile, isArchiveFile, getFileCategory, ALL_FILE_CATEGORIES } from '../utils';

// Components
import { Sidebar } from './dashboard/Sidebar';
import { TopBar } from './dashboard/TopBar';
import { FileExplorer } from './dashboard/FileExplorer';
import { TransferPanel } from './dashboard/TransferPanel';
import { cancelStaging } from '../hooks/useDroppedFileUpload';
import { MoveToFolderModal } from './dashboard/MoveToFolderModal';
import { PreviewModal } from './dashboard/PreviewModal';
import { ArchiveViewerModal } from './dashboard/ArchiveViewerModal';
import { MediaPlayer } from './dashboard/MediaPlayer';
import { DragDropOverlay } from './dashboard/DragDropOverlay';
import { RemoteUploadModal } from './dashboard/RemoteUploadModal';
import { PdfViewer } from './dashboard/PdfViewer';
import { SettingsPage } from './dashboard/SettingsPage';
import { AboutPage } from './dashboard/AboutPage';
import { ForwardToFolderModal } from './dashboard/ForwardToFolderModal';
import { VaultPasscodeModal } from './dashboard/VaultPasscodeModal';
import { VaultView } from './dashboard/VaultView';
import { usePublicChannels, usePublicChannelFiles } from '../hooks/usePublicChannels';
import { ActiveView } from '../types';
import { useConfirm } from '../context/ConfirmContext';

// Hooks
import { useTelegramConnection } from '../hooks/useTelegramConnection';
import { useFileOperations } from '../hooks/useFileOperations';
import { useFileUpload } from '../hooks/useFileUpload';
import { useFileDownload } from '../hooks/useFileDownload';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useSettings } from '../context/SettingsContext';
import { useCacheSession } from '../context/CacheSessionContext';
import { useResponsive } from '../hooks/useResponsive';
import { useVault, VaultKind } from '../context/VaultContext';
import { filterHidden } from '../context/VaultContext';

export function Dashboard({ onLogout }: { onLogout: () => void }) {
    const queryClient = useQueryClient();
    const cacheSession = useCacheSession();
    const { isMobile } = useResponsive();
    const vault = useVault();


    const {
        store, folders, activeFolderId, setActiveFolderId, isConnected,
        handleLogout, handleCreateFolder, handleFolderRename, handleFolderDelete, handleFolderReorder
    } = useTelegramConnection(onLogout);

    const [activeView, setActiveView] = useState<ActiveView>({ type: 'saved' });
        const { publicChannels, removeChannel, syncFromRemote } = usePublicChannels();
        const [showForwardModal, setShowForwardModal] = useState(false);
        const { confirm } = useConfirm();

        // ---- Vault filtering (spec §4.2, load-bearing) --------------------
        // ONE memo derives the visible lists; these flow to ALL consumers
        // (Sidebar, pickers). Raw arrays are used ONLY by persistence paths
        // (reorder/sync payloads) — filtering at any writer would silently
        // delete vaulted folders from the store.
        const visibleFolders = vault.ready
            ? filterHidden(folders, f => f.id, vault.hiddenFolderIds)
            : folders; // vault state unresolved: render nothing-hidden yet (locked-assumed, no leak — hidden ids unknown while locked)
        const visiblePublicChannels = vault.ready
            ? filterHidden(publicChannels, c => c.channel_id, vault.hiddenPublicIds)
            : publicChannels;

        // Hide helper for Phase 3 entry points (context menu / drop).
        // D14: hiding the currently-viewing channel jumps to Saved Messages,
        // clears selection, and closes modals showing its files.
        const handleHideInVault = useCallback(async (kind: VaultKind, id: number) => {
            const viewingIt =
                (activeView.type === 'folder' && kind === 'folder' && activeView.folderId === id) ||
                (activeView.type === 'public' && kind === 'public_channel' && activeView.channelId === id);
            try {
                await vault.hide(kind, id);
                toast.success('Hidden in Vault');
            } catch (e) {
                if (String(e).includes('passcode_required')) {
                    setShowCreatePasscode(true);
                    pendingHideRef.current = { kind, id };
                    return;
                }
                toast.error('Failed to hide in Vault');
                return;
            }
            if (viewingIt) {
                setActiveView({ type: 'saved' });
                setSelectedIds([]);
                setPreviewFile(null);
                toast.message('Moved to Saved Messages — channel is now in the Vault');
            }
        }, [activeView, vault]);

        // First-hide gating (D16): passcode creation must complete before the
        // item hides. The pending hide is applied once the dialog succeeds.
        const [showCreatePasscode, setShowCreatePasscode] = useState(false);
        const pendingHideRef = useRef<{ kind: VaultKind; id: number } | null>(null);
        const completePendingHide = useCallback(async (passcode: string) => {
            const ok = await vault.setPasscode(passcode);
            if (!ok) return false;
            const pending = pendingHideRef.current;
            pendingHideRef.current = null;
            setShowCreatePasscode(false);
            if (pending) {
                try {
                    await vault.hide(pending.kind, pending.id);
                    toast.success('Hidden in Vault');
                } catch {
                    toast.error('Failed to hide in Vault');
                }
            }
            return true;
        }, [vault]);
        const cancelPendingHide = useCallback(() => {
            pendingHideRef.current = null;
            setShowCreatePasscode(false);
        }, []);

        // ---- Startup restore gating (spec §4.3) ----------------------------
        // The store restores a persisted activeFolderId before vault state
        // resolves; if that selection references a vaulted item we must NOT
        // land on it. Today an unstable-identity effect masks this by accident
        // (Dashboard.tsx sync-effect); this gate makes it a guarantee.
        const restoredIdRef = useRef<number | null>(null);
        useEffect(() => {
            if (!vault.ready) {
                if (activeFolderId !== null && restoredIdRef.current === null) {
                    restoredIdRef.current = activeFolderId;
                }
                return;
            }
            const restored = restoredIdRef.current;
            restoredIdRef.current = null;
            if (restored === null) return;
            if (vault.hiddenFolderIds.has(restored) || vault.hiddenPublicIds.has(restored)) {
                setActiveView({ type: 'saved' });
                store?.delete('activeFolderId').then(() => store?.save()).catch(() => {});
            }
        }, [vault.ready, vault.hiddenFolderIds, vault.hiddenPublicIds, activeFolderId, store]);

        // Ctrl+Shift+V — open Vault (D11). preventDefault: WebView2 reserves
        // this combo for paste-plain-text. Bound outside the input-guard path
        // so it works while typing (e.g. from the lock screen passcode field).
        const handleVaultHotkey = useCallback((e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'v' || e.key === 'V')) {
                e.preventDefault();
                e.stopPropagation();
                setActiveView(prev => prev.type === 'vault' ? prev : { type: 'vault' });
            }
        }, []);

        useEffect(() => {
            window.addEventListener('keydown', handleVaultHotkey, true);
            return () => window.removeEventListener('keydown', handleVaultHotkey, true);
        }, [handleVaultHotkey]);

        // ---- D3 edge case: hiding the vault entry while viewing it ----------
        useEffect(() => {
            if (vault.ready && vault.entryVisible === false && activeView.type === 'vault') {
                setActiveView({ type: 'saved' });
            }
        }, [vault.ready, vault.entryVisible, activeView.type]);

        // Wrapper: updates both activeView and activeFolderId atomically.
        // Sidebar calls this instead of raw setActiveFolderId so that clicking
        // a private folder switches activeView away from 'public' — otherwise
        // the useEffect below would immediately reset activeFolderId back.
        const handleSelectFolder = useCallback((id: number | null) => {
            if (id === null) {
                setActiveView({ type: 'saved' });
            } else {
                setActiveView({ type: 'folder', folderId: id });
            }
            setActiveFolderId(id);
        }, [setActiveFolderId]);

        // Sync activeFolderId with activeView for backward compat
            useEffect(() => {
            if (activeView.type === 'saved') {
                setActiveFolderId(null);
            } else if (activeView.type === 'folder') {
                setActiveFolderId(activeView.folderId);
            } else if (activeView.type === 'public') {
                setActiveFolderId(activeView.channelId);
            }
        }, [activeView, setActiveFolderId]);


    const { settings, updateSetting } = useSettings();
    const viewMode = settings.viewMode;
    const setViewMode = (mode: 'grid' | 'list') => updateSetting('viewMode', mode);

    const [previewFile, setPreviewFile] = useState<TelegramFile | null>(null);
    const [selectedIds, setSelectedIds] = useState<number[]>([]);
    const [showMoveModal, setShowMoveModal] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [showAbout, setShowAbout] = useState(false);
    const [showRemoteUpload, setShowRemoteUpload] = useState(false);
    const [showTransferPanel, setShowTransferPanel] = useState(false);
    const [searchTerm, setSearchTerm] = useState("");
    const [searchResults, setSearchResults] = useState<TelegramFile[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
        try { return localStorage.getItem('sidebar-collapsed') === 'true'; }
        catch { return false; }
    });
    // Auto-collapse sidebar on mobile
    const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
    const toggleSidebar = useCallback(() => {
        setSidebarCollapsed(prev => {
            const next = !prev;
            try { localStorage.setItem('sidebar-collapsed', String(next)); }
            catch { /* ignore */ }
            return next;
        });
    }, []);
    const [internalDragFileId, _setInternalDragFileId] = useState<number | null>(null);
    const internalDragRef = useRef<number | null>(null);

    const setInternalDragFileId = (id: number | null) => {
        internalDragRef.current = id;
        _setInternalDragFileId(id);
    };
    const [playingFile, setPlayingFile] = useState<TelegramFile | null>(null);
    const [pdfFile, setPdfFile] = useState<TelegramFile | null>(null);
    const [archiveFile, setArchiveFile] = useState<TelegramFile | null>(null);
    const [previewContextFiles, setPreviewContextFiles] = useState<TelegramFile[]>([]);
    const [previewContextIndex, setPreviewContextIndex] = useState(-1);

    const isPublicView = activeView.type === 'public';
    const isReadOnly = isPublicView;
    const { files: pubChannelFiles, isLoading: pubFilesLoading, hasMore: pubHasMore, lastOffsetId: pubLastOffsetId, notAMember: pubNotAMember, loadMore } = usePublicChannelFiles(
        isPublicView ? activeView.channelId : null
    );

    // --- External file drag-drop (upload) ---
    // WebView2 routes native OS file drops through the DOCUMENT (capture phase), not
    // React's synthetic onDrop — so we register document-level listeners in an effect
    // below. dropCtxRef mirrors the latest values so that once-registered listener never
    // reads stale closures.
    const FILE_ID_MIME = 'application/x-telegram-file-id';
    const FOLDER_REORDER_MIME = 'application/x-nobuf-folder-reorder';
    const [externalDragActive, setExternalDragActive] = useState(false);
    const [uploadLimitBytes, setUploadLimitBytes] = useState(2_000_000_000);
    // Re-fetch the Premium-aware limit whenever the Telegram connection (re)establishes,
    // so a mid-session account change isn't stuck with the stale mount-time value.
    useEffect(() => {
        if (!isConnected) return;
        invoke<number>('cmd_upload_limit').then(setUploadLimitBytes).catch(() => {});
    }, [isConnected]);
    // Public channels are read-only; only saved/folder views accept uploads.
    const canUploadHere = !isReadOnly;
    // Staging-in-progress rows (dropped files being copied to %TEMP% before they
    // enter the upload queue). Keyed by name; cleared when its batch finishes.
    const [stagingItems, setStagingItems] = useState<{ name: string; pct: number }[]>([]);
    // Names the user cancelled: their in-flight chunk's progress callback must not
    // resurrect the row after removal (that forced a second cancel click).
    const cancelledStagingRef = useRef<Set<string>>(new Set());
    const dropCtxRef = useRef<{ canUploadHere: boolean; limit: number; connected: boolean; stage: ((f: File[], l: number, hasFolder: boolean, onStagingProgress?: (fileName: string, pct: number) => void) => Promise<void>) | null }>({ canUploadHere: true, limit: 2_000_000_000, connected: false, stage: null });
    // Last dragover/drop timestamp for external drags. WebView2 fires NO event when a
    // drag is cancelled mid-window (Esc key): dragleave carries in-window coordinates
    // and dragend only fires on the (external) source. The watchdog below uses this to
    // dismiss the overlay when drags silently die.
    const lastExternalDragActivityRef = useRef(0);


    const { data: nbFiles = [], isLoading: nbFilesLoading, error } = useQuery({
        queryKey: ['files', activeFolderId],
        queryFn: () => invoke<any[]>('cmd_get_files', { folderId: activeFolderId }).then(res => res.map(f => ({
            ...f,
            sizeStr: formatBytes(f.size),
            type: f.icon_type || (f.name.endsWith('/') ? 'folder' : 'file')
        }))),
        enabled: !!store && !isPublicView && vault.ready,
    });

    const allFiles = isPublicView ? pubChannelFiles : nbFiles;
    const isLoading = isPublicView ? pubFilesLoading : nbFilesLoading;

    const displayedFiles = (() => {
        // 1. Apply search filter
        const searchFiltered = searchTerm.length > 2
            ? searchResults
            : allFiles.filter((f: TelegramFile) => f.name.toLowerCase().includes(searchTerm.toLowerCase()));

        // 2. Apply category filter (folders always pass through)
        const activeFilter = settings.fileFilter;
        if (activeFilter.length === 0 || activeFilter.length === ALL_FILE_CATEGORIES.length) {
            return searchFiltered; // no filter or all selected = show everything
        }
        return searchFiltered.filter((f: TelegramFile) => {
            if (f.type === 'folder') return true; // folders always visible
            return activeFilter.includes(getFileCategory(f.name));
        });
    })();

    const { data: bandwidth } = useQuery({
        queryKey: ['bandwidth'],
        queryFn: () => invoke<BandwidthStats>('cmd_get_bandwidth'),
        refetchInterval: 5000,
        enabled: !!store
    });


    const {
        handleDelete, handleBulkDelete, handleBulkDownload,
        handleBulkMove, handleGlobalSearch

    } = useFileOperations(activeFolderId, selectedIds, setSelectedIds, displayedFiles);

    const { uploadQueue, setUploadQueue, handleManualUpload, handleFolderUpload, handleRemoteUpload, stageAndQueue, cancelAll: cancelUploads, cancelItem: cancelUploadItem, retryItem: retryUploadItem, isDragging } = useFileUpload(activeFolderId, store);
    const { downloadQueue, queueDownload, queueDownloadWithSavePath, clearFinished: clearDownloads, cancelAll: cancelDownloads, cancelItem: cancelDownloadItem, retryItem: retryDownloadItem } = useFileDownload(store);

    // Sync active download progress to cacheSession badge so the percentage stays accurate
    useEffect(() => {
        for (const item of downloadQueue) {
            if ((item.status === 'downloading' || item.status === 'pending') && item.progress !== undefined) {
                const cached = cacheSession.getCacheInfo(item.messageId);
                if (cached && item.progress > cached.percentage) {
                    cacheSession.updateCachePercent(item.messageId, item.progress);
                }
            }
            // Remove cache badge only on cancel/error — cache data is deleted in these cases.
            // On success (100%), keep the badge — the disk cache data is still there.
            if (item.status === 'cancelled' || item.status === 'error') {
                const cached = cacheSession.getCacheInfo(item.messageId);
                if (cached) {
                    cacheSession.removeCache(item.messageId);
                }
            }
        }
    }, [downloadQueue, cacheSession]);

    // Handle "Continue Download" from VideoCacheDialog — queues download in panel with cache percentage
    const handleContinueToDownload = useCallback(async (messageId: number, filename: string, folderId: number | null, savePath: string, fromCachePercent: number) => {
        // console.log(`[CACHE-DOWNLOAD] Queuing download from ${fromCachePercent}% for msg=${messageId}`);
        queueDownloadWithSavePath(messageId, filename, folderId, savePath, fromCachePercent);
    }, [queueDownloadWithSavePath]);


    const handleSelectAll = useCallback(() => {
        setSelectedIds(displayedFiles.map(f => f.id));
    }, [displayedFiles]);

    // Auto-open transfer panel only when NEW items are added to queue
    const prevQueueLenRef = useRef({ u: uploadQueue.length, d: downloadQueue.length });
    useEffect(() => {
        const prevU = prevQueueLenRef.current.u;
        const prevD = prevQueueLenRef.current.d;
        prevQueueLenRef.current = { u: uploadQueue.length, d: downloadQueue.length };
        if (uploadQueue.length > prevU || downloadQueue.length > prevD) {
            setShowTransferPanel(true);
        }
    }, [uploadQueue.length, downloadQueue.length]);

    const handleKeyboardDelete = useCallback(() => {
        if (selectedIds.length > 0) {
            handleBulkDelete();
        }
    }, [selectedIds, handleBulkDelete]);

    const handleEscape = useCallback(() => {
        setSelectedIds([]);
        setSearchTerm("");
        setPreviewFile(null);
        setPlayingFile(null);
        setPdfFile(null);
    }, []);

    const handleFocusSearch = useCallback(() => {
        const searchInput = document.querySelector('input[placeholder="Search files..."]') as HTMLInputElement;
        if (searchInput) {
            searchInput.focus();
            searchInput.select();
        }
    }, []);

    const handleEnter = useCallback(() => {
        if (selectedIds.length === 1) {
            const selected = displayedFiles.find(f => f.id === selectedIds[0]);
            if (selected) {
                if (selected.type === 'folder') {
                    setActiveFolderId(selected.id);
                } else {
                    handlePreview(selected, displayedFiles);
                }
            }
        }
    }, [selectedIds, displayedFiles, setActiveFolderId]);

    useKeyboardShortcuts({
        onSelectAll: handleSelectAll,
        onDelete: handleKeyboardDelete,
        onEscape: handleEscape,
        onSearch: handleFocusSearch,
        onEnter: handleEnter,
        enabled: !previewFile && !playingFile && !pdfFile && !showMoveModal // Disable when modals are open
    });

    // [ key toggles sidebar
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
            if (e.key === '[') {
                e.preventDefault();
                toggleSidebar();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [toggleSidebar]);


    useEffect(() => {
        setSelectedIds([]);
        setShowMoveModal(false);
        setSearchTerm("");
        setSearchResults([]);
        setPreviewFile(null);
        setPlayingFile(null);
        setPdfFile(null);
        setPreviewContextFiles([]);
        setPreviewContextIndex(-1);
        setMobileSidebarOpen(false);
        }, [activeFolderId]);


    useEffect(() => {
        if (searchTerm.length <= 2) {
            setSearchResults([]);
            return;
        }

        const timer = setTimeout(async () => {
            setIsSearching(true);
            const results = await handleGlobalSearch(searchTerm);
            setSearchResults(results);
            setIsSearching(false);
        }, 500);

        return () => clearTimeout(timer);
    }, [searchTerm]);




    const handleFileClick = (e: React.MouseEvent, id: number) => {
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey) {
            // Ctrl/Cmd+click: toggle multi-select
            setSelectedIds(ids => ids.includes(id) ? ids.filter(i => i !== id) : [...ids, id]);
        } else {
            const file = displayedFiles.find(f => f.id === id);
            if (file) {
                setSelectedIds([id]);
                if (file.type === 'folder') {
                    setActiveFolderId(file.id);
                } else {
                    handlePreview(file, displayedFiles);
                }
            }
        }
    }

    const handleToggleSelection = useCallback((id: number) => {
        setSelectedIds(ids => ids.includes(id) ? ids.filter(i => i !== id) : [...ids, id]);
    }, []);

    const handlePreview = (file: TelegramFile, orderedFiles?: TelegramFile[]) => {
        const contextFiles = (orderedFiles || displayedFiles).filter((f) => f.type !== 'folder');
        const contextIndex = contextFiles.findIndex((f) => f.id === file.id);

        setPreviewContextFiles(contextFiles);
        setPreviewContextIndex(contextIndex);

        const isMedia = isMediaFile(file.name);
        const isPdf = isPdfFile(file.name);
        const isArchive = isArchiveFile(file.name);

        if (isMedia) {
            setPlayingFile(file);
            setPreviewFile(null);
            setPdfFile(null);
            setArchiveFile(null);
        } else if (isPdf) {
            setPdfFile(file);
            setPreviewFile(null);
            setPlayingFile(null);
            setArchiveFile(null);
        } else if (isArchive) {
            setArchiveFile(file);
            setPreviewFile(null);
            setPlayingFile(null);
            setPdfFile(null);
        } else {
            setPreviewFile(file);
            setPlayingFile(null);
            setPdfFile(null);
            setArchiveFile(null);
        }
    };

    const navigatePreview = useCallback((step: 1 | -1) => {
        if (previewContextFiles.length === 0) return;

        const currentFileId = previewFile?.id ?? playingFile?.id ?? pdfFile?.id;
        if (!currentFileId) return;

        const currentIndex = previewContextFiles.findIndex((f) => f.id === currentFileId);
        if (currentIndex === -1) return;

        const nextIndex = (currentIndex + step + previewContextFiles.length) % previewContextFiles.length;
        const nextFile = previewContextFiles[nextIndex];
        if (!nextFile) return;

        setPreviewContextIndex(nextIndex);

        const isMedia = isMediaFile(nextFile.name);
        const isPdf = isPdfFile(nextFile.name);

        if (isMedia) {
            setPlayingFile(nextFile);
            setPreviewFile(null);
            setPdfFile(null);
        } else if (isPdf) {
            setPdfFile(nextFile);
            setPreviewFile(null);
            setPlayingFile(null);
        } else {
            setPreviewFile(nextFile);
            setPlayingFile(null);
            setPdfFile(null);
        }
    }, [previewContextFiles, previewFile, playingFile, pdfFile]);

    const handleNextPreview = useCallback(() => {
        navigatePreview(1);
    }, [navigatePreview]);

    const handlePrevPreview = useCallback(() => {
        navigatePreview(-1);
    }, [navigatePreview]);

    const previewNeighborFiles = useCallback(() => {
        if (previewContextFiles.length === 0) {
            return { nextFile: null as TelegramFile | null, prevFile: null as TelegramFile | null };
        }

        const currentFileId = previewFile?.id ?? playingFile?.id ?? pdfFile?.id;
        if (!currentFileId) {
            return { nextFile: null as TelegramFile | null, prevFile: null as TelegramFile | null };
        }

        const currentIdx = previewContextFiles.findIndex((f) => f.id === currentFileId);
        if (currentIdx === -1) {
            return { nextFile: null as TelegramFile | null, prevFile: null as TelegramFile | null };
        }

        const nextIdx = (currentIdx + 1) % previewContextFiles.length;
        const prevIdx = (currentIdx - 1 + previewContextFiles.length) % previewContextFiles.length;

        return {
            nextFile: previewContextFiles[nextIdx] || null,
            prevFile: previewContextFiles[prevIdx] || null,
        };
    }, [previewContextFiles, previewFile, playingFile, pdfFile]);

    const handleDropOnFolder = async (e: React.DragEvent, targetFolderId: number | null) => {
        e.preventDefault();
        e.stopPropagation();

        const dataTransferFileId = e.dataTransfer.getData("application/x-telegram-file-id");

        if (activeFolderId === targetFolderId) return;

        const fileId = internalDragRef.current || (dataTransferFileId ? parseInt(dataTransferFileId) : null);

        if (fileId) {
            try {
                const idsToMove = selectedIds.includes(fileId) ? selectedIds : [fileId];

                await invoke('cmd_move_files', {
                    messageIds: idsToMove,
                    sourceFolderId: activeFolderId,
                    targetFolderId: targetFolderId
                });

                queryClient.invalidateQueries({ queryKey: ['files', activeFolderId] });

                if (selectedIds.includes(fileId)) setSelectedIds([]);

                toast.success(`Moved ${idsToMove.length} file(s).`);

                setInternalDragFileId(null);
            } catch {
                toast.error(`Failed to move file(s).`);
            }
        }
    }

    const handleLoadMore = useCallback(() => {
            if (!loadMore.isPending && pubLastOffsetId) {
                loadMore.mutate(pubLastOffsetId);
            }
        }, [loadMore, pubLastOffsetId]);

        const handleRemovePublicChannel = async (channelId: number) => {
            const channel = publicChannels.find(c => c.channel_id === channelId);
        if (!channel) return;

        const shouldRemove = await confirm({
            title: `Remove "${channel.name}" from NoBuf?`,
            message: 'This will remove the channel from your NoBuf sidebar.',
            confirmText: 'Remove',
            cancelText: 'Cancel'
        });
        
        if (!shouldRemove) return;
        
        const shouldLeave = await confirm({
            title: 'Also leave on Telegram?',
            message: 'You will no longer receive messages from this channel on Telegram.',
            confirmText: 'Leave Channel',
            cancelText: 'Keep Subscribed'
        });
        
        removeChannel.mutate({ channelId, leaveOnTelegram: shouldLeave });
        toast.success(`Removed "${channel.name}" from NoBuf.`);
        
        if (activeView.type === 'public' && activeView.channelId === channelId) {
            setActiveView({ type: 'saved' });
        }
    };

    const currentFolderName = activeView.type === 'vault'
        ? "Vault"
        : activeView.type === 'public'
        ? (publicChannels.find(c => c.channel_id === activeView.channelId)?.name || "Public Channel")
        : activeFolderId === null
            ? "Saved Messages"
            : folders.find(f => f.id === activeFolderId)?.name || "Folder";


    // Keep dropCtxRef current so the document-level listeners (registered once) never
    // read stale state.
    dropCtxRef.current = {
        canUploadHere,
        limit: uploadLimitBytes,
        stage: stageAndQueue,
        connected: isConnected,
    };
    // Staging progress rows: upsert on each chunk, remove when the batch settles
    // (item either enters the queue or was rejected/failed).
    const updateStagingProgress = useCallback((fileName: string, pct: number) => {
        // A cancelled name stays suppressed until a FRESH staging starts for it
        // (pct=0 clears the guard), so late callbacks from its final in-flight
        // chunk can't bring the row back.
        if (cancelledStagingRef.current.has(fileName)) return;
        setStagingItems(prev => {
            const others = prev.filter(i => i.name !== fileName);
            return pct < 100 ? [...others, { name: fileName, pct }] : others;
        });
    }, []);

    // Register native document-level drag/drop listeners in the CAPTURE phase. WebView2
    // delivers external OS file drops here — React's synthetic onDrop on a div does not
    // fire for them. Internal drags (file→folder, folder reorder) carry custom MIME types
    // and are ignored here so their own React handlers keep working untouched.
    useEffect(() => {
        const isExternal = (dt: DataTransfer | null) => {
            if (!dt) return false;
            const t = Array.from(dt.types);
            return t.includes('Files') && !t.includes(FILE_ID_MIME) && !t.includes(FOLDER_REORDER_MIME);
        };
        const onDragOver = (e: DragEvent) => {
            if (!isExternal(e.dataTransfer)) return;
            e.preventDefault();  // required so 'drop' fires
            lastExternalDragActivityRef.current = Date.now();
            if (e.dataTransfer) e.dataTransfer.dropEffect = dropCtxRef.current.canUploadHere ? 'copy' : 'none';
            setExternalDragActive(true);
        };
        const onDragLeave = (e: DragEvent) => {
            if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
                setExternalDragActive(false);
            }
        };
        const onDrop = async (e: DragEvent) => {
            if (!isExternal(e.dataTransfer)) {
                // Non-file, non-internal drop (e.g. a link or text dragged in from a
                // browser) would navigate the whole webview on drop. Block that —
                // unless the target is an editable field, where text drops are legit.
                const t = e.dataTransfer ? Array.from(e.dataTransfer.types) : [];
                const isInternal = t.includes(FILE_ID_MIME) || t.includes(FOLDER_REORDER_MIME);
                if (!isInternal) {
                    const el = e.target as HTMLElement | null;
                    if (!el?.closest?.('input, textarea, [contenteditable="true"]')) e.preventDefault();
                }
                return;  // internal drops handled by their own targets
            }
            e.preventDefault();
            e.stopPropagation();
            lastExternalDragActivityRef.current = Date.now();
            setExternalDragActive(false);
            // Vault drop zones reject file drops (D10) — the vault hides
            // channels, not files. Hit-test BEFORE any staging work.
            const droppedOnVault = (e.target as HTMLElement | null)?.closest?.('[data-vault-dropzone]');
            if (droppedOnVault) {
                toast.error('Only channels can be hidden');
                return;
            }
            const { canUploadHere: canUp, limit, stage } = dropCtxRef.current;
            // Detect folders SYNCHRONOUSLY before any await — the items list is neutralized
            // after the handler yields. A dropped folder appears in .files as a zero-byte
            // File, so webkitGetAsEntry().isDirectory is the only reliable discriminator.
            let hasFolder = false;
            const items = e.dataTransfer?.items;
            if (items) {
                for (let i = 0; i < items.length; i++) {
                    const entry = items[i].webkitGetAsEntry?.();
                    if (entry?.isDirectory) { hasFolder = true; break; }
                }
            }
            const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
            if (!dropCtxRef.current.connected) {
                toast.error("Not connected to Telegram — connect first, then drop files.");
                return;
            }
            if (!canUp) {
                toast.error("Can't upload to a public channel — switch to Saved Messages or a folder.");
                return;
            }
            if (files.length === 0 || !stage) return;
            await stage(files, limit, hasFolder, updateStagingProgress);
        };
        document.addEventListener('dragover', onDragOver, true);
        document.addEventListener('dragleave', onDragLeave, true);
        document.addEventListener('drop', onDrop, true);
        return () => {
            document.removeEventListener('dragover', onDragOver, true);
            document.removeEventListener('dragleave', onDragLeave, true);
            document.removeEventListener('drop', onDrop, true);
        };
    }, []);

    // External-drag overlay dismissal for the cases the DOM never reports:
    // - Esc key cancels an OS drag mid-window; WebView2 fires no dragleave/dragend
    // - a drag can silently die (source window destroyed) without any event
    // While the overlay is up we watch for both: Escape directly, and a dragover
    // heartbeat that stops arriving. Gated on externalDragActive → zero cost otherwise.
    useEffect(() => {
        if (!externalDragActive) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setExternalDragActive(false);
        };
        const watchdog = window.setInterval(() => {
            if (Date.now() - lastExternalDragActivityRef.current > 700) setExternalDragActive(false);
        }, 150);
        window.addEventListener('keydown', onKey);
        return () => {
            window.clearInterval(watchdog);
            window.removeEventListener('keydown', onKey);
        };
    }, [externalDragActive]);

    const previewNeighbors = previewNeighborFiles();

    // Compute transfer counts for badge (separate upload/download)
    const uploadActiveCount = uploadQueue.filter(i => i.status === 'pending' || i.status === 'uploading').length;
    const uploadFinishedCount = uploadQueue.filter(i => i.status === 'success' || i.status === 'error' || i.status === 'cancelled').length;
    const downloadActiveCount = downloadQueue.filter(i => i.status === 'pending' || i.status === 'downloading').length;
    const downloadFinishedCount = downloadQueue.filter(i => i.status === 'success' || i.status === 'error' || i.status === 'cancelled').length;

    return (
        <div
            className="flex h-screen w-full overflow-hidden bg-nobuf-bg relative"
            onClick={() => setSelectedIds([])}
            onDragOver={(e) => { if (internalDragRef.current) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; } }}
            onDragEnter={(e) => { if (internalDragRef.current) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; } }}
        >

            <AnimatePresence>
                {showMoveModal && (
                    <MoveToFolderModal
                        folders={visibleFolders}
                        onClose={() => setShowMoveModal(false)}
                        onSelect={handleBulkMove}
                        activeFolderId={activeFolderId}
                        key="move-modal"
                    />
                )}
                <RemoteUploadModal
                    open={showRemoteUpload}
                    onClose={() => setShowRemoteUpload(false)}
                    onSubmit={handleRemoteUpload}
                />
                {playingFile && (
                    <MediaPlayer
                                            file={playingFile}
                                            onClose={() => setPlayingFile(null)}
                                            onNext={handleNextPreview}
                                            onPrev={handlePrevPreview}
                                            currentIndex={previewContextIndex}
                                            totalItems={previewContextFiles.length}
                                            activeFolderId={activeFolderId}
                                            onContinueToDownload={handleContinueToDownload}
                                            isAlreadyDownloading={playingFile ? downloadQueue.some(i => i.messageId === playingFile.id && (i.status === 'pending' || i.status === 'downloading')) : false}
                                            isPublicChannel={isPublicView}
                                            key="media-player"
                                        />
                )}
                {pdfFile && (
                    <PdfViewer
                        file={pdfFile}
                        onClose={() => setPdfFile(null)}
                        onNext={handleNextPreview}
                        onPrev={handlePrevPreview}
                        currentIndex={previewContextIndex}
                        totalItems={previewContextFiles.length}
                        activeFolderId={activeFolderId}
                        key="pdf-viewer"
                    />
                )}
                {archiveFile && (
                    <ArchiveViewerModal
                        file={archiveFile}
                        activeFolderId={activeFolderId}
                        onClose={() => setArchiveFile(null)}
                    />
                )}
                {isDragging && internalDragFileId === null && <DragDropOverlay key="drag-drop-overlay" />}
                {externalDragActive && (
                    <DragDropOverlay
                        key="external-drop-overlay"
                        variant={canUploadHere ? 'accept' : 'reject'}
                        folderName={canUploadHere ? currentFolderName : undefined}
                    />
                )}
            </AnimatePresence>

            {isMobile && mobileSidebarOpen && (
                <div className="fixed inset-0 z-30 bg-black/50" onClick={() => setMobileSidebarOpen(false)} />
            )}
            <Sidebar
                folders={visibleFolders}
                activeFolderId={activeFolderId}
                setActiveFolderId={handleSelectFolder}
                onDrop={handleDropOnFolder}
                onDelete={handleFolderDelete}
                onRename={handleFolderRename}
                onReorder={handleFolderReorder}
                onCreate={handleCreateFolder}
                isConnected={isConnected}
                bandwidth={bandwidth || null}
                collapsed={sidebarCollapsed}
                onToggleCollapse={toggleSidebar}
                mobileOpen={mobileSidebarOpen}
                onMobileClose={() => setMobileSidebarOpen(false)}
                activeView={activeView}
                publicChannels={visiblePublicChannels}
                onSelectPublicChannel={(channelId) => setActiveView({ type: 'public', channelId })}
                onPublicChannelsChanged={() => syncFromRemote.mutate()}
                onRemovePublicChannel={handleRemovePublicChannel}
                onOpenVault={() => setActiveView({ type: 'vault' })}
                onHideInVault={handleHideInVault}
                onVaultRejectFileDrop={() => toast.error('Only channels can be hidden')}
                vaultEntryVisible={vault.entryVisible}
                vaultCount={vault.totalCount}
            />

            <main className="flex-1 flex flex-col" onClick={(e) => { if (e.target === e.currentTarget) setSelectedIds([]); }}>
                <TopBar
                    currentFolderName={currentFolderName}
                    selectedIds={selectedIds}
                    onShowMoveModal={() => setShowMoveModal(true)}
                    onBulkDownload={handleBulkDownload}
                    onBulkDelete={handleBulkDelete}
                    onSelectAll={handleSelectAll}
                    viewMode={viewMode}
                    setViewMode={setViewMode}
                    searchTerm={searchTerm}
                    onSearchChange={setSearchTerm}
                    onSettingsClick={() => setShowSettings(true)}
                    onAboutClick={() => setShowAbout(true)}
                    onRemoteUpload={() => setShowRemoteUpload(true)}
                    onToggleTransfers={() => setShowTransferPanel(p => !p)}
                    showTransferPanel={showTransferPanel}
                    uploadActiveCount={uploadActiveCount}
                    uploadFinishedCount={uploadFinishedCount}
                    downloadActiveCount={downloadActiveCount}
                    downloadFinishedCount={downloadFinishedCount}
                    onToggleMobileSidebar={() => setMobileSidebarOpen(o => !o)}
                    isMobile={isMobile}
                />
                {searchTerm.length > 2 && (
                    <div className="px-6 pt-4 pb-0">
                        <h2 className="text-sm font-medium text-nobuf-subtext">
                            Search Results for <span className="text-nobuf-primary">"{searchTerm}"</span>
                        </h2>
                    </div>
                )}
                {activeView.type === 'vault' ? (
                    <VaultView
                        onOpenFolder={(id) => setActiveView({ type: 'folder', folderId: id })}
                        onOpenPublicChannel={(id) => setActiveView({ type: 'public', channelId: id })}
                        getFolderName={(id) => folders.find(f => f.id === id)?.name || `Unknown folder (${id})`}
                        getChannelName={(id) => publicChannels.find(c => c.channel_id === id)?.name || `Unknown channel (${id})`}
                    />
                ) : (
                <FileExplorer

                    files={displayedFiles}
                    loading={isLoading || isSearching}
                    error={error}
                    viewMode={viewMode}
                    selectedIds={selectedIds}
                    activeFolderId={activeFolderId}
                    onFileClick={handleFileClick}
                    onDelete={handleDelete}
                    onDownload={(id, name) => queueDownload(id, name, activeFolderId)}
                    onPreview={handlePreview}
                    onManualUpload={handleManualUpload}
                    onFolderUpload={handleFolderUpload}
                    onSelectionClear={() => setSelectedIds([])}
                    onToggleSelection={handleToggleSelection}
                    onDrop={handleDropOnFolder}
                    onDragStart={(fileId) => setInternalDragFileId(fileId)}
                    onDragEnd={() => setTimeout(() => setInternalDragFileId(null), 50)}
                    readOnly={isReadOnly}
                    hasMore={isPublicView ? pubHasMore : false}
                                        onLoadMore={isPublicView ? handleLoadMore : undefined}
                    notAMember={isPublicView ? pubNotAMember : false}
                    onRemoveChannel={isPublicView && activeView.type === 'public' ? () => handleRemovePublicChannel(activeView.channelId) : undefined}
                    showForwardOption={isReadOnly}
                    onForwardToFolder={() => setShowForwardModal(true)}
                />
                )}
            </main>

            {previewFile && (
                <PreviewModal
                    file={previewFile}
                    activeFolderId={activeFolderId}
                    onClose={() => setPreviewFile(null)}
                    onNext={handleNextPreview}
                    onPrev={handlePrevPreview}
                    currentIndex={previewContextIndex}
                    totalItems={previewContextFiles.length}
                    nextFile={previewNeighbors.nextFile}
                    prevFile={previewNeighbors.prevFile}
                />
            )}


            <TransferPanel
                isOpen={showTransferPanel}
                onClose={() => setShowTransferPanel(false)}
                uploadItems={uploadQueue}
                stagingItems={stagingItems}
                onCancelStaging={name => {
                    cancelledStagingRef.current.add(name);
                    cancelStaging(name);
                    // Remove the preparing row immediately; the staging loop's
                    // StagingCancelledError path discards partial bytes + toasts.
                    setStagingItems(prev => prev.filter(i => i.name !== name));
                }}
                onClearUploadFinished={() => setUploadQueue(q => q.filter(i => i.status !== 'success' && i.status !== 'error' && i.status !== 'cancelled'))}
                onCancelAllUploads={cancelUploads}
                onCancelUploadItem={cancelUploadItem}
                onRetryUploadItem={retryUploadItem}
                downloadItems={downloadQueue}
                onClearDownloadFinished={clearDownloads}
                onCancelAllDownloads={cancelDownloads}
                onCancelDownloadItem={cancelDownloadItem}
                onRetryDownloadItem={retryDownloadItem}
            />

            <AnimatePresence>
                {showSettings && (
                    <SettingsPage
                        onClose={() => setShowSettings(false)}
                        onLogout={handleLogout}
                        onOpenVault={() => { setShowSettings(false); setActiveView({ type: 'vault' }); }}
                    />
                )}
            </AnimatePresence>

            <AnimatePresence>
                {showAbout && (
                    <AboutPage onClose={() => setShowAbout(false)} />
                )}
            </AnimatePresence>

            <ForwardToFolderModal
                open={showForwardModal}
                onClose={() => setShowForwardModal(false)}
                sourceChannelId={activeView.type === 'public' ? activeView.channelId : 0}
                selectedFileIds={selectedIds}
                folders={visibleFolders}
                onForwarded={() => {
                    queryClient.invalidateQueries({ queryKey: ['files'] });
                }}
            />

            {/* Vault first-hide passcode creation (D16). Pending hide applies on success. */}
            {showCreatePasscode && (
                <VaultPasscodeModal
                    mode="create"
                    title="Create Vault Passcode"
                    description="Choose a numeric passcode (4-12 digits) to protect your vault. You'll need it to view hidden channels."
                    submitLabel="Create & Hide"
                    onSubmit={completePendingHide}
                    onClose={cancelPendingHide}
                />
            )}
        </div>
    );
}
