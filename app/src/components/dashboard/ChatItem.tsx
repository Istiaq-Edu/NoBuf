import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Trash2, Lock, User, Bot, Users, ChevronRight } from 'lucide-react';
import { ChatInfo, CHAT_DRAG_MIME, CHAT_REORDER_MIME } from '../../types';

interface FolderGroup {
    id: number;
    name: string;
    color_hex: string;
}

interface Props {
    chat: ChatInfo;
    active: boolean;
    collapsed: boolean;
    onClick: () => void;
    onRemove: () => void;
    /** Vault (D8): right-click → "Hide in Vault" + drag MIME. */
    onHideInVault?: () => void;
    /** Colored-group assignment (D9) — the ONLY assignment entry point. */
    onAssignGroup?: (groupId: number | null) => void;
    currentGroupId?: number | null;
    groupColor?: string | null;
    /** Drag-reorder within the Chats section (D12). */
    onChatDragOver?: (e: React.DragEvent) => void;
    onChatDragLeave?: (e: React.DragEvent) => void;
    onChatDrop?: (e: React.DragEvent) => void;
    onChatDragEnd?: (e: React.DragEvent) => void;
    reorderIndicator?: 'above' | 'below' | null;
    /** Internal file-drop → move into this chat (D17 drag gesture). */
    onFileDrop?: (e: React.DragEvent) => void;
}

// m6 (F-C8): bots are peer_kind 'user' + is_bot — the old Bot arm was dead code.
function KindIcon({ peerKind, isBot, className }: { peerKind: string; isBot?: boolean; className?: string }) {
    if (peerKind === 'user') return isBot ? <Bot className={className} /> : <User className={className} />;
    return <Users className={className} />;
}

/**
 * Chat sidebar entry (normal_chats, plan F2). PublicChannelItem clone with
 * the V2-09 deltas: no is_member dot, group-color ring on the avatar,
 * folder-style reorder drag plumbing, kind icon, and the SidebarItem-style
 * "Move to Group" submenu (D9's only UI entry point).
 */
export function ChatItem({
    chat, active, collapsed, onClick, onRemove, onHideInVault,
    onAssignGroup, currentGroupId, groupColor,
    onChatDragOver, onChatDragLeave, onChatDrop: onChatDropHandler, onChatDragEnd,
    reorderIndicator, onFileDrop,
}: Props) {
    const [showMenu, setShowMenu] = useState(false);
    const [showGroupSubmenu, setShowGroupSubmenu] = useState(false);
    const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
    const [availableGroups, setAvailableGroups] = useState<FolderGroup[]>([]);

    useEffect(() => {
        if (showGroupSubmenu && onAssignGroup) {
            invoke<FolderGroup[]>('cmd_get_groups').then(setAvailableGroups).catch(() => {});
        }
    }, [showGroupSubmenu, onAssignGroup]);

    // Close on ANY outside mousedown (SidebarItem.tsx:111-120 pattern). A row-local
    // onMouseDown only closes the menu when the next click lands back on THIS row —
    // right-clicking another row left the old menu mounted (stacked menus bug).
    const menuDivRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!showMenu) return;
        const handler = (e: MouseEvent) => {
            if (menuDivRef.current && !menuDivRef.current.contains(e.target as Node)) {
                setShowMenu(false);
                setShowGroupSubmenu(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [showMenu]);

    return (
        <div
            className={`group flex items-center rounded-lg transition-all cursor-pointer relative ${
                collapsed ? 'relative justify-center w-8 h-8' : 'px-3 gap-2.5'
            } py-2 ${
                active
                    ? 'bg-nobuf-primary/15 text-nobuf-primary'
                    : 'text-nobuf-text hover:bg-nobuf-hover'
            } ${reorderIndicator === 'above' ? 'border-t-2 border-nobuf-primary' : ''} ${
                reorderIndicator === 'below' ? 'border-b-2 border-nobuf-primary' : ''
            }`}
            onClick={onClick}
            title={collapsed ? chat.title : undefined}
            draggable={!collapsed}
            onDragStart={(e) => {
                if (collapsed) { e.preventDefault(); return; }
                // Reorder drag (same gesture as folders — SidebarItem pattern).
                e.dataTransfer.setData(CHAT_REORDER_MIME, String(chat.chat_id));
                // Vault-hide drag (PublicChannelItem pattern).
                e.dataTransfer.setData(CHAT_DRAG_MIME, String(chat.chat_id));
                e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
                if (e.dataTransfer.types.includes(CHAT_REORDER_MIME)) {
                    onChatDragOver?.(e);
                } else if (e.dataTransfer.types.includes('application/x-telegram-file-id')) {
                    // Internal file drag → move-into-chat target (D17).
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'move';
                }
            }}
            onDragLeave={onChatDragLeave}
            onDrop={(e) => {
                if (e.dataTransfer.types.includes(CHAT_REORDER_MIME)) {
                    onChatDropHandler?.(e);
                } else if (e.dataTransfer.types.includes('application/x-telegram-file-id')) {
                    e.preventDefault();
                    e.stopPropagation();
                    onFileDrop?.(e);
                }
            }}
            onDragEnd={onChatDragEnd}
            onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenuPos({ x: e.clientX, y: e.clientY });
                setShowMenu(true);
                setShowGroupSubmenu(false);
            }}
        >
            {/* Avatar circle with first letter + group-color ring (V2-09b) */}
            <div className="relative shrink-0">
                <div
                    className={`${collapsed ? 'w-5 h-5' : 'w-6 h-6'} rounded-full flex items-center justify-center ${
                        active
                            ? 'bg-nobuf-primary/30'
                            : 'bg-gradient-to-br from-nobuf-primary/60 to-blue-500/60'
                    }`}
                    style={groupColor ? { boxShadow: `0 0 0 2px ${groupColor}` } : undefined}
                >
                    <span className="text-white font-bold text-[10px]">
                        {chat.title.charAt(0).toUpperCase()}
                    </span>
                </div>
                {/* Kind icon (V2-09d) — user/bot/group at the avatar's corner */}
                <KindIcon
                    peerKind={chat.peer_kind}
                    isBot={chat.is_bot}
                    className={`absolute ${collapsed ? '-top-1 -right-1 w-2 h-2' : '-top-1 -right-1 w-2.5 h-2.5'} text-nobuf-subtext bg-nobuf-surface rounded-full p-0.5`}
                />
            </div>

            {!collapsed && (
                <>
                    <div className="flex-1 min-w-0">
                        <span className="text-sm truncate block">{chat.title}</span>
                        <span className="text-[10px] text-nobuf-subtext truncate block">
                            {chat.peer_kind === 'user' ? (chat.is_bot ? 'Bot' : 'Direct message')
                                : chat.peer_kind === 'basic_group' ? 'Group'
                                : 'Supergroup'}
                        </span>
                    </div>
                    {onHideInVault && (
                        <button
                            onClick={(e) => { e.stopPropagation(); onHideInVault(); }}
                            className="opacity-0 group-hover:opacity-100 text-nobuf-subtext hover:text-nobuf-primary transition-all shrink-0 p-1 rounded hover:bg-nobuf-primary/10"
                            title="Hide in Vault"
                        >
                            <Lock className="w-3.5 h-3.5" />
                        </button>
                    )}
                    <button
                        onClick={(e) => { e.stopPropagation(); onRemove(); }}
                        className="opacity-0 group-hover:opacity-100 text-nobuf-subtext hover:text-red-500 transition-all shrink-0 p-1 rounded hover:bg-red-500/10"
                        title="Remove from NoBuf"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                </>
            )}

            {showMenu && (
                <div
                    ref={(node) => { menuDivRef.current = node; }}
                    className="fixed z-50 bg-nobuf-surface/95 backdrop-blur-md border border-nobuf-border rounded-xl shadow-2xl py-1.5 min-w-[180px] animate-in fade-in zoom-in-95 duration-150"
                    style={{
                        left: Math.min(menuPos.x, window.innerWidth - 200),
                        top: Math.min(menuPos.y, window.innerHeight - 160),
                    }}
                    onClick={(e) => e.stopPropagation()}
                >
                    {onHideInVault && (
                        <button
                            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-nobuf-subtext hover:bg-nobuf-hover hover:text-nobuf-text rounded-lg mx-1 transition-all duration-150"
                            onClick={() => { setShowMenu(false); onHideInVault(); }}
                        >
                            <Lock className="w-4 h-4" />
                            Hide in Vault
                        </button>
                    )}
                    {onAssignGroup && (
                        <div className="relative">
                            <button
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-nobuf-subtext hover:bg-nobuf-hover hover:text-nobuf-text rounded-lg mx-1 transition-all duration-150"
                                onClick={() => setShowGroupSubmenu(v => !v)}
                            >
                                <span className="w-4 h-4 rounded-full border border-nobuf-border flex items-center justify-center">
                                    {groupColor && <span className="w-2 h-2 rounded-full" style={{ backgroundColor: groupColor }} />}
                                </span>
                                Move to Group
                                <ChevronRight className="w-3.5 h-3.5 ml-auto" />
                            </button>
                            {showGroupSubmenu && (
                                <div className="absolute left-full top-0 ml-1 bg-nobuf-surface/95 backdrop-blur-md border border-nobuf-border rounded-xl shadow-2xl py-1.5 min-w-[160px] animate-in fade-in zoom-in-95 duration-150">
                                    <button
                                        className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg mx-1 transition-all duration-150 ${currentGroupId === null ? 'text-nobuf-primary bg-nobuf-primary/10' : 'text-nobuf-subtext hover:bg-nobuf-hover hover:text-nobuf-text'}`}
                                        onClick={() => { setShowMenu(false); setShowGroupSubmenu(false); onAssignGroup(null); }}
                                    >
                                        None
                                    </button>
                                    {availableGroups.length === 0 && (
                                        <div className="px-3 py-2 text-xs text-nobuf-subtext italic">No groups created</div>
                                    )}
                                    {availableGroups.map(g => (
                                        <button
                                            key={g.id}
                                            className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg mx-1 transition-all duration-150 ${currentGroupId === g.id ? 'text-nobuf-primary bg-nobuf-primary/10' : 'text-nobuf-subtext hover:bg-nobuf-hover hover:text-nobuf-text'}`}
                                            onClick={() => { setShowMenu(false); setShowGroupSubmenu(false); onAssignGroup(g.id); }}
                                        >
                                            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: g.color_hex }} />
                                            <span className="truncate">{g.name}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
