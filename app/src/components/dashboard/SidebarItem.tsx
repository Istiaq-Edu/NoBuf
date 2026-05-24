import { useState, useRef, useEffect } from 'react';
import { Plus, Pencil, Trash2, Check, X } from 'lucide-react';

interface SidebarItemProps {
    icon: React.ElementType;
    label: string;
    active: boolean;
    onClick: () => void;
    onDrop: (e: React.DragEvent) => void;
    onDelete?: () => void;
    onRename?: (newName: string) => void;
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
}

const FOLDER_REORDER_MIME = 'application/x-nobuf-folder-reorder';

export function SidebarItem({
    icon: Icon, label, active = false, onClick, onDrop, onDelete, onRename,
    onFolderDragStart, onFolderDragOver, onFolderDragLeave, onFolderDrop, onFolderDragEnd,
    reorderIndicator, isFirst, isLast, folderId, collapsed
}: SidebarItemProps) {
    const [isOver, setIsOver] = useState(false);
    const [isRenaming, setIsRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState(label);
    const [showContextMenu, setShowContextMenu] = useState(false);
    const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
    const inputRef = useRef<HTMLInputElement>(null);
    const contextMenuRef = useRef<HTMLDivElement>(null);

    const isFolder = folderId !== null;

    useEffect(() => {
        if (isRenaming && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isRenaming]);

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

    return (
        <>
            {/* Reorder drop indicator line — rendered as a separate element above/below the button */}
            {reorderIndicator === 'above' && !(isFirst) && (
                <div className="h-0.5 bg-nobuf-primary rounded-full mx-2 shrink-0" />
            )}

            <button
                // CRITICAL: <button> elements are NOT draggable by default in HTML.
                // Without draggable="true", onDragStart never fires.
                draggable={isFolder && !isRenaming && !collapsed ? true : false}
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
                    // Only highlight for file drops (not reorder — reorder has its own indicator)
                    if (!isReorderDrag(e)) {
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
                className={`group w-full flex items-center rounded-lg text-sm font-medium transition-all duration-150 overflow-hidden ${collapsed ? 'relative justify-center py-2' : 'px-3 py-2 gap-3'} ${active
                    ? 'bg-nobuf-primary/10 text-nobuf-primary'
                    : isOver
                        ? 'bg-nobuf-primary/30 text-nobuf-text ring-2 ring-nobuf-primary scale-[1.02] shadow-lg'
                        : 'text-nobuf-subtext hover:bg-nobuf-hover hover:text-nobuf-text'
                    } ${isFolder && !isRenaming && !collapsed ? 'cursor-grab active:cursor-grabbing' : ''}`}
            >
                <Icon className={`w-4 h-4 shrink-0 ${collapsed ? 'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2' : ''} ${isOver ? 'text-nobuf-primary' : ''}`} />
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
                    className="fixed z-50 bg-nobuf-surface border border-nobuf-border rounded-lg shadow-xl py-1 min-w-[140px]"
                    style={{ left: contextMenuPos.x, top: contextMenuPos.y }}
                >
                    {onRename && (
                        <button
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-nobuf-subtext hover:bg-nobuf-hover hover:text-nobuf-text transition-colors"
                            onClick={startRename}
                        >
                            <Pencil className="w-3.5 h-3.5" />
                            Rename
                        </button>
                    )}
                    {onDelete && (
                        <button
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-nobuf-subtext hover:bg-red-500/10 hover:text-red-400 transition-colors"
                            onClick={() => { setShowContextMenu(false); onDelete(); }}
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            Delete
                        </button>
                    )}
                </div>
            )}
        </>
    )
}
