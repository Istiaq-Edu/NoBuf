import { useState, useCallback, useEffect } from 'react';
import { HardDrive, Folder, Plus, PanelLeftClose, PanelLeftOpen, Check, ChevronDown, ChevronRight } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { SidebarItem } from './SidebarItem';
import { BandwidthWidget } from './BandwidthWidget';
import { FolderGroupTabs } from './FolderGroupTabs';
import { TelegramFolder, BandwidthStats, ActiveView, PublicChannel } from '../../types';
import { PublicChannelSidebarSection } from './PublicChannelSidebarSection';

interface SidebarProps {
    folders: TelegramFolder[];
    activeFolderId: number | null;
    setActiveFolderId: (id: number | null) => void;
    onDrop: (e: React.DragEvent, folderId: number | null) => void;
    onDelete: (id: number, name: string) => void;
    onRename: (id: number, newName: string) => void;
    onReorder: (reordered: TelegramFolder[]) => void;
    onCreate: (name: string) => Promise<void>;
    isConnected: boolean;
    bandwidth: BandwidthStats | null;
    collapsed: boolean;
    onToggleCollapse: () => void;
    mobileOpen?: boolean;
    onMobileClose?: () => void;
    activeView: ActiveView;
    publicChannels: PublicChannel[];
    onSelectPublicChannel: (channelId: number) => void;
    onPublicChannelsChanged: () => void;
    onRemovePublicChannel?: (channelId: number) => void;
}

/**
 * Drag data type constants to distinguish between file-drop and folder-reorder.
 * File drops use "application/x-telegram-file-id" (existing mechanism).
 * Folder reorder uses "application/x-nobuf-folder-reorder" (new).
 */
const FOLDER_REORDER_MIME = 'application/x-nobuf-folder-reorder';

export function Sidebar({
    folders, activeFolderId, setActiveFolderId, onDrop, onDelete, onRename, onReorder, onCreate,
    isConnected, bandwidth, collapsed, onToggleCollapse,
    mobileOpen, onMobileClose: _onMobileClose,
    activeView, publicChannels, onSelectPublicChannel, onPublicChannelsChanged, onRemovePublicChannel
}: SidebarProps) {
    const [showNewFolderInput, setShowNewFolderInput] = useState(false);
    const [newFolderName, setNewFolderName] = useState("");
    const [activeGroupId, setActiveGroupId] = useState<number | null>(null);

    // Enriched folder data: maps folderId → { group_id, group_color }
    const [folderGroupMap, setFolderGroupMap] = useState<Record<number, { id: number | null; color: string | null }>>({});
    const [groupAssignVersion, setGroupAssignVersion] = useState(0);
    const [groupRefreshKey, setGroupRefreshKey] = useState(0);

    // New Group inline input
    const [showNewGroupInput, setShowNewGroupInput] = useState(false);
        const [newGroupName, setNewGroupName] = useState('');
        const [newGroupColor, setNewGroupColor] = useState('#22c55e');

        // Per-section collapse state (independent of sidebar-wide collapse)
        const [foldersExpanded, setFoldersExpanded] = useState(true);
        const [pubExpanded, setPubExpanded] = useState(true);

    const handleCreateGroup = async () => {
        if (!newGroupName.trim()) return;
        try {
            await invoke('cmd_create_group', { name: newGroupName.trim(), colorHex: newGroupColor });
            setNewGroupName('');
            setShowNewGroupInput(false);
            setGroupRefreshKey(k => k + 1);
        } catch (e) {
            console.error('Failed to create group:', e);
        }
    };

    // Fetch enriched folders to know which folder is in which group
    useEffect(() => {
        invoke<Array<{ id: number; group_id: number | null; group_color: string | null }>>('cmd_get_enriched_folders')
            .then(enriched => {
                const map: Record<number, { id: number | null; color: string | null }> = {};
                for (const f of enriched) {
                    map[f.id] = { id: f.group_id, color: f.group_color };
                }
                setFolderGroupMap(map);
            })
            .catch(() => {});
    }, [groupAssignVersion]);

    // Filter folders by active group
    const filteredFolders = activeGroupId === null
        ? folders
        : folders.filter(f => (folderGroupMap[f.id]?.id ?? null) === activeGroupId);

    const handleAssignGroup = useCallback(async (folderId: number, groupId: number | null) => {
        try {
            await invoke('cmd_assign_folder_to_group', { channelId: folderId, groupId });
            setGroupAssignVersion(v => v + 1);
        } catch (e) {
            console.error('Failed to assign group:', e);
        }
    }, []);

    // Reorder drag state: tracks which folder is being dragged and
    // where it would be inserted (the index of the drop target).
    const [dragOverFolderId, setDragOverFolderId] = useState<number | null>(null);
    const [dragOverPosition, setDragOverPosition] = useState<'above' | 'below' | null>(null);

    const submitCreate = async () => {
        if (!newFolderName.trim()) return;
        try {
            await onCreate(newFolderName);
            setNewFolderName("");
            setShowNewFolderInput(false);
        } catch {
            // handled by parent
        }
    }

    // Compute reorder: move dragged folder to the position indicated by dragOver.
    const handleReorderDrop = useCallback((draggedFolderId: number) => {
        if (dragOverFolderId === null || dragOverPosition === null) return;
        if (draggedFolderId === dragOverFolderId) return; // no-op

        const draggedIndex = folders.findIndex(f => f.id === draggedFolderId);
        if (draggedIndex === -1) return;

        const targetIndex = folders.findIndex(f => f.id === dragOverFolderId);
        if (targetIndex === -1) return;

        // Compute the actual insertion index.
        // If dragging above target, insert before it. If below, insert after it.
        // But need to account for the dragged item being removed first.
        const reordered = [...folders];
        const [draggedItem] = reordered.splice(draggedIndex, 1);

        // After removing dragged item, find the target's new index
        const newTargetIndex = reordered.findIndex(f => f.id === dragOverFolderId);
        const insertIndex = dragOverPosition === 'above' ? newTargetIndex : newTargetIndex + 1;

        reordered.splice(insertIndex, 0, draggedItem);
        onReorder(reordered);

        // Clear drag state
        setDragOverFolderId(null);
        setDragOverPosition(null);
    }, [folders, dragOverFolderId, dragOverPosition, onReorder]);

    // Folder reorder drag handlers — called from SidebarItem
    const handleFolderDragStart = useCallback((e: React.DragEvent, folderId: number) => {
        e.dataTransfer.setData(FOLDER_REORDER_MIME, String(folderId));
        e.dataTransfer.effectAllowed = 'move';
        // Also set a small drag image so it looks right
    }, []);

    const handleFolderDragOver = useCallback((e: React.DragEvent, folderId: number) => {
        // Only respond if this is a folder reorder drag (not a file drag)
        if (!e.dataTransfer.types.includes(FOLDER_REORDER_MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';

        // Determine position: above or below the target based on mouse Y
        const rect = e.currentTarget.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const position = e.clientY < midY ? 'above' : 'below';

        setDragOverFolderId(folderId);
        setDragOverPosition(position);
    }, []);

    const handleFolderDragLeave = useCallback((e: React.DragEvent) => {
        // Only clear if actually leaving the element (not entering a child)
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX;
        const y = e.clientY;
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
            setDragOverFolderId(null);
            setDragOverPosition(null);
        }
    }, []);

    const handleFolderDrop = useCallback((e: React.DragEvent) => {
        const reorderData = e.dataTransfer.getData(FOLDER_REORDER_MIME);
        if (reorderData) {
            e.preventDefault();
            e.stopPropagation();
            handleReorderDrop(Number(reorderData));
            return;
        }
        // If not a reorder drop, fall through to file drop
    }, [handleReorderDrop]);

    const handleDragEnd = useCallback(() => {
        setDragOverFolderId(null);
        setDragOverPosition(null);
    }, []);

    return (
        <aside className={`${collapsed ? 'w-16' : 'w-64'} h-screen max-sm:h-full bg-nobuf-surface border-r border-nobuf-border flex flex-col overflow-hidden transition-[width] duration-200 ease-in-out shrink-0 max-sm:fixed max-sm:inset-y-0 max-sm:left-0 max-sm:z-40 max-sm:shadow-2xl ${mobileOpen ? 'max-sm:translate-x-0' : 'max-sm:-translate-x-full'} max-sm:transition-transform max-sm:duration-300`} onClick={e => e.stopPropagation()}>

            {/* Toggle button — left aligned */}
            <div className={`flex items-center pt-3 pb-2 shrink-0 ${collapsed ? 'px-4' : 'px-3'}`}>
                <button
                    onClick={onToggleCollapse}
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-nobuf-subtext hover:text-nobuf-text hover:bg-nobuf-hover transition-colors"
                    title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                >
                    {collapsed
                        ? <PanelLeftOpen className="w-4 h-4" />
                        : <PanelLeftClose className="w-4 h-4" />
                    }
                </button>
            </div>

            {/* Folder group chips — only show when sidebar is expanded */}
            {!collapsed && (
                <div className="border-b border-nobuf-border">
                    <FolderGroupTabs
                        activeGroupId={activeGroupId}
                        onGroupSelect={setActiveGroupId}
                        refreshKey={groupRefreshKey}
                    />
                </div>
            )}

            {/* Scrollable area — both Private and Public sections share flex-1 space */}
                        <nav className={`flex-1 flex flex-col overflow-y-auto overflow-x-hidden min-h-0 sidebar-scroll py-2 ${collapsed ? 'px-2' : 'px-3'}`}>
                            {/* Saved Messages — always visible */}
                            <SidebarItem
                                icon={HardDrive}
                                label="Saved Messages"
                                active={activeFolderId === null}
                                onClick={() => setActiveFolderId(null)}
                                onDrop={(e: React.DragEvent) => onDrop(e, null)}
                                folderId={null}
                                collapsed={collapsed}
                            />

                            {/* Private Channels section header — collapsible */}
                            {!collapsed && (
                                <button
                                    onClick={() => setFoldersExpanded(e => !e)}
                                    className="flex items-center gap-1.5 px-1 pt-3 pb-1 text-xs font-semibold text-nobuf-subtext uppercase tracking-wider hover:text-nobuf-text transition-colors w-full text-left group"
                                >
                                    {foldersExpanded
                                        ? <ChevronDown className="w-3.5 h-3.5 shrink-0 transition-transform" />
                                        : <ChevronRight className="w-3.5 h-3.5 shrink-0 transition-transform" />
                                    }
                                    <span className="flex-1">Private Channels</span>
                                    {filteredFolders.length > 0 && (
                                        <span className="text-[10px] font-normal text-nobuf-subtext/60 bg-nobuf-hover px-1.5 py-0.5 rounded-full">
                                            {filteredFolders.length}
                                        </span>
                                    )}
                                </button>
                            )}

                            {/* Folder list — conditional render (no max-h clipping) */}
                                                        {(foldersExpanded || collapsed) && (
                                                            <>
                                                                {filteredFolders.map((folder, index) => (
                                                                    <SidebarItem
                                                                        key={folder.id}
                                                                        icon={Folder}
                                                                        label={folder.name}
                                                                        active={activeFolderId === folder.id}
                                                                        onClick={() => setActiveFolderId(folder.id)}
                                                                        onDrop={(e: React.DragEvent) => {
                                                                            const reorderData = e.dataTransfer.getData(FOLDER_REORDER_MIME);
                                                                            if (reorderData) {
                                                                                handleReorderDrop(Number(reorderData));
                                                                                return;
                                                                            }
                                                                            onDrop(e, folder.id);
                                                                        }}
                                                                        onDelete={() => onDelete(folder.id, folder.name)}
                                                                        onRename={(newName: string) => onRename(folder.id, newName)}
                                                                        onAssignGroup={(groupId) => handleAssignGroup(folder.id, groupId)}
                                                                        currentGroupId={folderGroupMap[folder.id]?.id ?? null}
                                                                        groupColor={folderGroupMap[folder.id]?.color ?? null}
                                                                        onFolderDragStart={(e: React.DragEvent) => handleFolderDragStart(e, folder.id)}
                                                                        onFolderDragOver={(e: React.DragEvent) => handleFolderDragOver(e, folder.id)}
                                                                        onFolderDragLeave={handleFolderDragLeave}
                                                                        onFolderDrop={(e: React.DragEvent) => handleFolderDrop(e)}
                                                                        onFolderDragEnd={handleDragEnd}
                                                                        reorderIndicator={dragOverFolderId === folder.id ? dragOverPosition : null}
                                                                        isFirst={index === 0}
                                                                        isLast={index === filteredFolders.length - 1}
                                                                        folderId={folder.id}
                                                                        collapsed={collapsed}
                                                                    />
                                                                ))}
                                                            </>
                                                                                        )}

                                                                                        {/* Divider between Private and Public sections */}
                                                                                        <div className="h-px bg-nobuf-border mx-2 my-2 shrink-0" />

                                                                                        {/* Public Channels section — inside nav so it shares scroll space */}
                            <PublicChannelSidebarSection
                                channels={publicChannels}
                                activeView={activeView}
                                collapsed={collapsed}
                                onSelect={onSelectPublicChannel}
                                onRemoved={onPublicChannelsChanged}
                                onRemove={onRemovePublicChannel}
                                expanded={pubExpanded}
                                onToggleExpand={() => setPubExpanded(e => !e)}
                            />
                        </nav>

            {/* Create Folder + New Group — bottom row */}
            <div className={`border-b border-nobuf-border shrink-0 space-y-2 pb-2 ${collapsed ? 'flex flex-col px-4' : 'px-3'}`}>
                {/* Inline input for Create Folder */}
                {showNewFolderInput ? (
                    <div className="px-2 py-2 bg-nobuf-hover rounded-lg border border-nobuf-primary/30">
                        <div className="flex items-center gap-2 mb-2">
                            <Folder className="w-4 h-4 text-nobuf-primary shrink-0" />
                            <span className="text-xs font-medium text-nobuf-subtext">New Channel</span>
                        </div>
                        <input
                            autoFocus
                            type="text"
                            className="w-full bg-nobuf-bg rounded-lg px-3 py-2 text-sm text-nobuf-text placeholder:text-nobuf-subtext focus:outline-none focus:ring-2 focus:ring-nobuf-primary/40 transition-all border border-nobuf-border"
                            placeholder="Enter channel name..."
                            value={newFolderName}
                            onChange={e => setNewFolderName(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter') submitCreate();
                                if (e.key === 'Escape') { setShowNewFolderInput(false); setNewFolderName(''); }
                            }}
                        />
                        <div className="flex gap-2 mt-2">
                            <button
                                onClick={submitCreate}
                                disabled={!newFolderName.trim()}
                                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-nobuf-primary text-nobuf-county-green rounded-lg hover:brightness-110 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                <Check className="w-3.5 h-3.5" />
                                Create
                            </button>
                            <button
                                onClick={() => { setShowNewFolderInput(false); setNewFolderName(''); }}
                                className="px-3 py-1.5 text-xs font-medium text-nobuf-subtext hover:text-nobuf-text bg-nobuf-bg border border-nobuf-border rounded-lg transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                ) : (
                    /* Inline input for New Group */
                    showNewGroupInput ? (
                        <div className="px-2 py-2 bg-nobuf-hover rounded-lg border border-nobuf-primary/30">
                            <div className="flex items-center gap-2 mb-2">
                                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: newGroupColor }} />
                                <span className="text-xs font-medium text-nobuf-subtext">New Group</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <input
                                    type="color"
                                    value={newGroupColor}
                                    onChange={(e) => setNewGroupColor(e.target.value)}
                                    className="w-7 h-7 rounded cursor-pointer bg-transparent border border-nobuf-border shrink-0"
                                />
                                <input
                                    autoFocus
                                    type="text"
                                    className="flex-1 bg-nobuf-bg rounded-lg px-3 py-2 text-sm text-nobuf-text placeholder:text-nobuf-subtext focus:outline-none focus:ring-2 focus:ring-nobuf-primary/40 transition-all border border-nobuf-border"
                                    placeholder="Group name..."
                                    value={newGroupName}
                                    onChange={e => setNewGroupName(e.target.value)}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter') handleCreateGroup();
                                        if (e.key === 'Escape') { setShowNewGroupInput(false); setNewGroupName(''); }
                                    }}
                                />
                            </div>
                            <div className="flex gap-2 mt-2">
                                <button
                                    onClick={handleCreateGroup}
                                    disabled={!newGroupName.trim()}
                                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-nobuf-primary text-nobuf-county-green rounded-lg hover:brightness-110 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    <Check className="w-3.5 h-3.5" />
                                    Create
                                </button>
                                <button
                                    onClick={() => { setShowNewGroupInput(false); setNewGroupName(''); }}
                                    className="px-3 py-1.5 text-xs font-medium text-nobuf-subtext hover:text-nobuf-text bg-nobuf-bg border border-nobuf-border rounded-lg transition-colors"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className={`flex gap-2 ${collapsed ? 'flex-col items-center' : ''}`}>
                            <button
                                onClick={() => { if (collapsed) onToggleCollapse(); setShowNewFolderInput(true); }}
                                className={`flex items-center justify-center rounded-lg text-xs font-medium text-nobuf-subtext hover:bg-nobuf-hover hover:text-nobuf-text transition-all border border-dashed border-nobuf-border hover:border-nobuf-primary/40 active:scale-95 gap-1.5 ${collapsed ? 'w-8 h-8' : 'flex-1 px-3 py-2'}`}
                                title="Create Folder"
                            >
                                <Plus className="w-3.5 h-3.5 shrink-0" />
                                {!collapsed && <span>Folder</span>}
                            </button>
                            <button
                                onClick={() => { if (collapsed) onToggleCollapse(); setShowNewGroupInput(true); }}
                                className={`flex items-center justify-center rounded-lg text-xs font-medium text-nobuf-subtext hover:bg-nobuf-hover hover:text-nobuf-text transition-all border border-dashed border-nobuf-border hover:border-nobuf-primary/40 active:scale-95 gap-1.5 ${collapsed ? 'w-8 h-8' : 'flex-1 px-3 py-2'}`}
                                title="New Group"
                            >
                                <Plus className="w-3.5 h-3.5 shrink-0" />
                                {!collapsed && <span>Group</span>}
                            </button>
                        </div>
                    )
                )}
            </div>

            {/* Footer — connection status + bandwidth */}
            <div className={`border-t border-nobuf-border shrink-0 ${collapsed ? 'px-4 py-3' : 'p-3'}`}>
                <div className={`flex items-center text-nobuf-subtext text-xs mb-2 gap-2`}>
                    <div className={`w-2 h-2 rounded-full shrink-0 ${isConnected ? 'bg-nobuf-primary animate-pulse' : 'bg-red-500'}`}></div>
                    <span className={`whitespace-nowrap overflow-hidden transition-all duration-200 ${collapsed ? 'max-w-0 opacity-0' : 'max-w-[200px] opacity-100'}`}>
                        {isConnected ? 'Connected' : 'Disconnected'}
                    </span>
                </div>

                {/* Bandwidth — fades out when collapsed */}
                <div className={`transition-all duration-200 overflow-hidden ${collapsed ? 'max-h-0 opacity-0 mt-0' : 'max-h-40 opacity-100'}`}>
                    {bandwidth && <BandwidthWidget bandwidth={bandwidth} />}
                </div>
            </div>

        </aside>
    )
}
