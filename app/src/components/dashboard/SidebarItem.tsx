import { useState, useRef, useEffect } from 'react';
import { Plus, Pencil, Trash2, Check, X, FolderInput, Lock } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { PUBLIC_CHANNEL_DRAG_MIME, CHAT_DRAG_MIME } from '../../types';

interface FolderGroup {
    id: number;
    name: string;
    color_hex: string;
    display_order: number;
}

interface SidebarItemProps {
    icon: React.ElementType;
    label: string;
    active: boolean;
    onClick: () => void;
    onDrop: (e: React.DragEvent) => void;
    onDelete?: () => void;
    onRename?: (newName: string) => void;
    onAssignGroup?: (groupId: number | null) => void;
    currentGroupId?: number | null;
    groupColor?: string | null;
    /** Folder reorder drag — only for folders (folderId !== null). */
    onFolderDragStart?: (e: React.DragEvent) => void;
    onFolderDragOver?: (e: React.DragEvent) => void;
    onFolderDragLeave?: (e: React.DragEvent) => void;
    onFolderDrop?: (e: React.DragEvent) => void;
    onFolderDragEnd?: () => void;
    /** Visual indicator for reorder drop target: 'above' shows a line above, 'below' below. */
    reorderIndicator?: 'above' | 'below' | null;
    /** Edge-case flags for reorder: prevent dropping above the first item or below the last. */
    isFirst?: boolean;
    isLast?: boolean;
    folderId: number | null;
    collapsed?: boolean;
    /** Vault (D9/D10): show "Hide in Vault" in the context menu. */
    onHideInVault?: () => void;
    /** Adopted-folder marker: gates Unadopt vs Delete menu items. */
    isAdopted?: boolean;
    /** Unadopt (remove from NoBuf; channel stays on Telegram). Adopted folders only. */
    onUnadopt?: () => void;
    /** Really delete the Telegram channel. Adopted folders only; UI gates behind a stronger danger dialog. */
    onDeleteChannelPermanently?: () => void;
    /** Vault drop target: a folder-reorder drag dropped here HIDES that folder (D9/D10). */
    onVaultDropFolder?: (folderId: number) => void;
    /** Vault drop target: a public-channel drag dropped here HIDES that channel (D9/D10). */
    onVaultDropPublicChannel?: (channelId: number) => void;
    /** Vault drop target: a chat drag dropped here HIDES that chat (D8, review2 V2-01). */
    onVaultDropChat?: (chatId: number) => void;
    /** Count pill (D15). Rendered only when > 0; positioned per collapsed state. */
    badgeCount?: number;
}

const FOLDER_REORDER_MIME = 'application/x-nobuf-folder-reorder';

export function SidebarItem({
    icon: Icon, label, active = false, onClick, onDrop, onDelete, onRename, onAssignGroup, currentGroupId, groupColor,
    onFolderDragStart, onFolderDragOver, onFolderDragLeave, onFolderDrop, onFolderDragEnd,
    reorderIndicator, isFirst, isLast, folderId, collapsed, onHideInVault, onVaultDropFolder, onVaultDropPublicChannel, onVaultDropChat, badgeCount,
    isAdopted, onUnadopt, onDeleteChannelPermanently
}: SidebarItemProps) {
    const [isOver, setIsOver] = useState(false);
    const [isRenaming, setIsRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState(label);
    const [showContextMenu, setShowContextMenu] = useState(false);
    const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
    const [showGroupSubmenu, setShowGroupSubmenu] = useState(false);
    const [availableGroups, setAvailableGroups] = useState<FolderGroup[]>([]);
    const inputRef = useRef<HTMLInputElement>(null);
    const contextMenuRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);

    const isFolder = folderId !== null;

    useEffect(() => {
        if (isRenaming && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isRenaming]);

    // Safety net for a stuck drop-target highlight. Two WebView2 gaps this covers:
    //  1) Moving the dragged file OFF this folder without dropping — the element's own
    //     `onDragLeave` rect check can miss (stale coords / child targets), leaving isOver
    //     stuck. `dragover` fires continuously on whatever is under the cursor, so if a
    //     document-level dragover lands outside this button, we clear.
    //  2) Drag termination — `onDragEnd` never fires on the drop TARGET (it fires on the
    //     dragged FileCard source), so we also clear on document dragend/drop.
    useEffect(() => {
        if (!isOver) return;
        const clearIfOutside = (e: DragEvent) => {
            const el = buttonRef.current;
            if (!el) return;
            const r = el.getBoundingClientRect();
            if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
                setIsOver(false);
            }
        };
        const clear = () => setIsOver(false);
        document.addEventListener('dragover', clearIfOutside, true);
        document.addEventListener('dragend', clear, true);
        document.addEventListener('drop', clear, true);
        return () => {
            document.removeEventListener('dragover', clearIfOutside, true);
            document.removeEventListener('dragend', clear, true);
            document.removeEventListener('drop', clear, true);
        };
    }, [isOver]);

    useEffect(() => {
        if (!showContextMenu) return;
        const handler = (e: MouseEvent) => {
            if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
                setShowContextMenu(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [showContextMenu]);

    const submitRename = () => {
        const trimmed = renameValue.trim();
        if (trimmed && trimmed !== label && onRename) {
            onRename(trimmed);
        } else {
            setRenameValue(label);
        }
        setIsRenaming(false);
    };

    const cancelRename = () => {
        setRenameValue(label);
        setIsRenaming(false);
    };

    const startRename = () => {
        setShowContextMenu(false);
        setRenameValue(label);
        setIsRenaming(true);
    };

    // Determine if a drag event is a folder reorder (vs file drop)
    const isReorderDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(FOLDER_REORDER_MIME);

    // External OS file drags carry 'Files' (and neither internal MIME). Their drops are
    // captured at the document level (Dashboard) and upload to the CURRENT folder —
    // highlighting this folder would promise a targeted drop that never happens.
    const isExternalFilesDrag = (e: React.DragEvent) =>
        e.dataTransfer.types.includes('Files') &&
        !e.dataTransfer.types.includes('application/x-telegram-file-id') &&
        !e.dataTransfer.types.includes(FOLDER_REORDER_MIME);

    return (
        <>
            {/* Reorder drop indicator line — rendered as a separate element above/below the button */}
            {reorderIndicator === 'above' && !(isFirst) && (
                <div className="h-0.5 bg-nobuf-primary rounded-full mx-2 shrink-0" />
            )}

            <button
                ref={buttonRef}
                // CRITICAL: <button> elements are NOT draggable by default in HTML.
                // Without draggable="true", onDragStart never fires.
                draggable={isFolder && !isRenaming && !collapsed ? true : false}
                data-vault-dropzone={onVaultDropFolder ? 'true' : undefined}
                onClick={onClick}
                onDoubleClick={() => {
                    if (isFolder && onRename && !isRenaming) {
                        startRename();
                    }
                }}
                // Folder reorder: start drag on a folder item (not during rename, not when collapsed)
                onDragStart={(e) => {
                    if (!isFolder || isRenaming || collapsed) {
                        e.preventDefault();
                        return;
                    }
                    if (onFolderDragStart) onFolderDragStart(e);
                }}
                onDragEnter={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // Highlight only for INTERNAL file drops (not reorder — it has its own
                    // indicator; not external 'Files' drags — their drop is captured away
                    // to the current-folder uploader, so a highlight here would lie).
                    if (!isReorderDrag(e) && !isExternalFilesDrag(e)) {
                        setIsOver(true);
                    }
                }}
                onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (isReorderDrag(e)) {
                        e.dataTransfer.dropEffect = 'move';
                        if (onFolderDragOver) onFolderDragOver(e);
                    } else {
                        e.dataTransfer.dropEffect = 'move';
                    }
                }}
                onDragLeave={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    const x = e.clientX;
                    const y = e.clientY;
                    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
                        setIsOver(false);
                        if (onFolderDragLeave) onFolderDragLeave(e);
                    }
                }}
                onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsOver(false);

                    // Priority 0 (vault drop target): folder-reorder and
                    // public-channel drags are HIDE actions — consumed here so
                    // they never fall through to reorder/file logic (§4.2 order).
                    if ((onVaultDropFolder || onVaultDropPublicChannel) && isReorderDrag(e) && onVaultDropFolder) {
                        const raw = e.dataTransfer.getData(FOLDER_REORDER_MIME);
                        if (raw) {
                            onVaultDropFolder(Number(raw));
                            return;
                        }
                    }
                    if (onVaultDropPublicChannel && e.dataTransfer.types.includes(PUBLIC_CHANNEL_DRAG_MIME)) {
                        const raw = e.dataTransfer.getData(PUBLIC_CHANNEL_DRAG_MIME);
                        if (raw) {
                            onVaultDropPublicChannel(Number(raw));
                            return;
                        }
                    }
                    // Priority 0 (chat vault drop, V2-01): a CHAT_DRAG_MIME drag
                    // dropped on the vault item HIDES that chat. Without this
                    // arm the drag silently does nothing (D8 + QA row 10).
                    if (onVaultDropChat && e.dataTransfer.types.includes(CHAT_DRAG_MIME)) {
                        const raw = e.dataTransfer.getData(CHAT_DRAG_MIME);
                        if (raw) {
                            onVaultDropChat(Number(raw));
                            return;
                        }
                    }

                    // Priority 1: folder reorder drop
                    if (isReorderDrag(e) && onFolderDrop) {
                        onFolderDrop(e);
                        return;
                    }

                    // Priority 2: file drop into folder
                    if (onDrop) onDrop(e);
                }}
                onDragEnd={() => {
                    setIsOver(false);
                    if (onFolderDragEnd) onFolderDragEnd();
                }}
                onContextMenu={(e) => {
                    if (isFolder) {
                        e.preventDefault();
                        setContextMenuPos({ x: e.clientX, y: e.clientY });
                        setShowContextMenu(true);
                    }
                }}
                title={collapsed ? label : undefined}
                // When this item is the reorder drop target, add a subtle shift animation
                className={`group flex items-center rounded-lg text-sm font-medium transition-all duration-150 shrink-0 ${collapsed ? 'relative justify-center w-8 h-8' : 'w-full px-3 py-2 gap-3'} ${active
                    ? 'bg-nobuf-primary/10 text-nobuf-primary'
                    : isOver
                        ? 'bg-nobuf-primary/30 text-nobuf-text ring-2 ring-nobuf-primary scale-[1.02] shadow-lg'
                        : 'text-nobuf-subtext hover:bg-nobuf-hover hover:text-nobuf-text'
                    } ${isFolder && !isRenaming && !collapsed ? 'cursor-grab active:cursor-grabbing' : ''}`}
            >
                <Icon
                    className={`w-4 h-4 shrink-0 transition-colors ${collapsed ? 'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2' : ''} ${isOver ? 'text-nobuf-primary' : ''}`}
                    style={groupColor && !isOver ? { color: groupColor } : undefined}
                />
                {badgeCount !== undefined && badgeCount > 0 && (
                    <span
                        className={`shrink-0 text-[10px] font-semibold bg-nobuf-primary/20 text-nobuf-primary rounded-full px-1.5 py-0.5 ${collapsed ? 'absolute top-0.5 right-0.5 px-1 py-0' : ''}`}
                    >
                        {badgeCount}
                    </span>
                )}
                {isRenaming ? (
                    <div className="flex-1 flex items-center gap-1 min-w-0">
                        <input
                            ref={inputRef}
                            type="text"
                            className="w-full bg-white/10 rounded px-1 py-0 text-sm text-white focus:outline-none focus:ring-1 focus:ring-nobuf-primary min-w-0"
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter') { e.preventDefault(); submitRename(); }
                                if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                            }}
                            onBlur={() => submitRename()}
                        />
                        <div onClick={(e) => { e.stopPropagation(); submitRename(); }} className="shrink-0 p-0.5 hover:text-green-400 text-nobuf-subtext">
                            <Check className="w-3 h-3" />
                        </div>
                        <div onClick={(e) => { e.stopPropagation(); cancelRename(); }} className="shrink-0 p-0.5 hover:text-red-400 text-nobuf-subtext">
                            <X className="w-3 h-3" />
                        </div>
                    </div>
                ) : (
                    <span className={`flex-1 text-left truncate whitespace-nowrap transition-all duration-200 ${collapsed ? 'w-0 opacity-0' : 'opacity-100'}`}>{label}</span>
                )}
                {onDelete && !isRenaming && (
                    <div onClick={(e) => { e.stopPropagation(); onDelete(); }} className={`shrink-0 p-1 hover:text-red-400 transition-all duration-200 ${collapsed ? 'w-0 opacity-0' : 'opacity-0 group-hover:opacity-100'}`}>
                        <Plus className="w-3 h-3 rotate-45" />
                    </div>
                )}
            </button>

            {/* Reorder drop indicator line below */}
            {reorderIndicator === 'below' && !(isLast) && (
                <div className="h-0.5 bg-nobuf-primary rounded-full mx-2 shrink-0" />
            )}

            {/* Context menu for folders */}
            {showContextMenu && isFolder && (
                <div
                    ref={contextMenuRef}
                    className="fixed z-50 bg-nobuf-surface/95 backdrop-blur-md border border-nobuf-border rounded-xl shadow-2xl py-1.5 min-w-[180px] animate-in fade-in zoom-in-95 duration-150"
                    style={{
                        left: Math.min(contextMenuPos.x, window.innerWidth - 200),
                        top: Math.min(contextMenuPos.y, window.innerHeight - 200),
                    }}
                >
                    {onRename && (
                        <button
                            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-nobuf-subtext hover:bg-nobuf-hover hover:text-nobuf-text rounded-lg mx-1 transition-all duration-150"
                            onClick={startRename}
                        >
                            <Pencil className="w-4 h-4" />
                            Rename
                        </button>
                    )}
                    {onAssignGroup && (
                        <div className="relative">
                            <button
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-nobuf-subtext hover:bg-nobuf-hover hover:text-nobuf-text rounded-lg mx-1 transition-all duration-150"
                                onClick={() => {
                                    setShowGroupSubmenu(!showGroupSubmenu);
                                    if (!showGroupSubmenu) {
                                        invoke<FolderGroup[]>('cmd_get_groups').then(setAvailableGroups).catch(() => {});
                                    }
                                }}
                            >
                                <FolderInput className="w-4 h-4" />
                                Move to Group
                                <span className="ml-auto text-xs opacity-60">›</span>
                            </button>
                            {showGroupSubmenu && (
                                <div
                                    className="absolute bg-nobuf-surface/95 backdrop-blur-md border border-nobuf-border rounded-xl shadow-2xl py-1.5 min-w-[160px] animate-in fade-in slide-in-from-left-2 duration-150"
                                    style={{
                                        left: '100%',
                                        top: 0,
                                        marginLeft: '4px',
                                    }}
                                >
                                    <button
                                        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-nobuf-subtext hover:bg-nobuf-hover hover:text-nobuf-text rounded-lg mx-1 transition-all duration-150"
                                        onClick={() => { setShowContextMenu(false); setShowGroupSubmenu(false); onAssignGroup(null); }}
                                    >
                                        <span className="w-2.5 h-2.5 rounded-full bg-nobuf-subtext/40 border border-nobuf-subtext/20" />
                                        None
                                        {currentGroupId === null && <Check className="w-3.5 h-3.5 ml-auto text-nobuf-primary" />}
                                    </button>
                                    {availableGroups.map(g => (
                                        <button
                                            key={g.id}
                                            className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg mx-1 transition-all duration-150 ${currentGroupId === g.id ? 'bg-nobuf-primary/10 text-nobuf-text' : 'text-nobuf-subtext hover:bg-nobuf-hover hover:text-nobuf-text'}`}
                                            onClick={() => { setShowContextMenu(false); setShowGroupSubmenu(false); onAssignGroup(g.id); }}
                                        >
                                            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: g.color_hex }} />
                                            {g.name}
                                            {currentGroupId === g.id && <Check className="w-3.5 h-3.5 ml-auto" style={{ color: g.color_hex }} />}
                                        </button>
                                    ))}
                                    {availableGroups.length === 0 && (
                                        <div className="px-3 py-2 text-xs text-nobuf-subtext italic">No groups created</div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                    {onHideInVault && (
                        <>
                            <button
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-nobuf-subtext hover:bg-nobuf-hover hover:text-nobuf-text rounded-lg mx-1 transition-all duration-150"
                                onClick={() => { setShowContextMenu(false); onHideInVault(); }}
                            >
                                <Lock className="w-4 h-4" />
                                Hide in Vault
                            </button>
                            <div className="h-px bg-nobuf-border mx-2 my-1" />
                        </>
                    )}
                    {onUnadopt && isAdopted && (
                        <>
                            <button
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-nobuf-subtext hover:bg-nobuf-hover hover:text-nobuf-text rounded-lg mx-1 transition-all duration-150"
                                onClick={() => { setShowContextMenu(false); onUnadopt(); }}
                            >
                                <X className="w-4 h-4" />
                                Remove from NoBuf
                            </button>
                            <div className="h-px bg-nobuf-border mx-2 my-1" />
                            <div className="px-3 py-1 text-[10px] text-nobuf-subtext/70">
                                The channel and its subscribers stay on Telegram.
                            </div>
                        </>
                    )}
                    {onDelete && !isAdopted && (
                        <>
                            <div className="h-px bg-nobuf-border mx-2 my-1" />
                            <button
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-nobuf-subtext hover:bg-red-500/10 hover:text-red-400 rounded-lg mx-1 transition-all duration-150"
                                onClick={() => { setShowContextMenu(false); onDelete(); }}
                            >
                                <Trash2 className="w-4 h-4" />
                                Delete
                            </button>
                        </>
                    )}
                    {onDeleteChannelPermanently && isAdopted && (
                        <>
                            <div className="h-px bg-nobuf-border mx-2 my-1" />
                            <button
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-400/80 hover:bg-red-500/10 hover:text-red-400 rounded-lg mx-1 transition-all duration-150"
                                onClick={() => { setShowContextMenu(false); onDeleteChannelPermanently(); }}
                            >
                                <Trash2 className="w-4 h-4" />
                                Delete channel permanently…
                            </button>
                        </>
                    )}
                </div>
            )}
        </>
    )
}
