import { useState, useCallback } from 'react';
import { Plus, ChevronDown, ChevronRight } from 'lucide-react';
import { ChatInfo, ActiveView, CHAT_REORDER_MIME } from '../../types';
import { ChatItem } from './ChatItem';
import { AddChatModal } from './AddChatModal';

interface Props {
    chats: ChatInfo[];
    activeView: ActiveView;
    collapsed: boolean;
    onSelect: (chatId: number) => void;
    onAdded: (chat: ChatInfo) => void;
    onRemove: (chatId: number, title: string) => void;
    onReorder: (reordered: ChatInfo[]) => void;
    onHideInVault?: (chatId: number) => void;
    onAssignGroup?: (chatId: number, groupId: number | null) => void;
    /** chatId → { id, color } from cmd_get_enriched_chats (D9 chip filter). */
    chatGroupMap: Record<number, { id: number | null; color: string | null }>;
    /** Internal file drag → move into chat (D17). */
    onFileDropOnChat?: (chatId: number, e: React.DragEvent) => void;
    expanded?: boolean;
    onToggleExpand?: () => void;
}

/**
 * Chats sidebar section (plan F2, D4/D10): always visible with header +
 * '+' between Private Channels and Public Channels. PublicChannelSidebarSection
 * clone with the folder-style reorder machinery (Sidebar.tsx:143-219 pattern,
 * scoped within this section).
 */
export function ChatSidebarSection({
    chats, activeView, collapsed, onSelect, onAdded, onRemove, onReorder,
    onHideInVault, onAssignGroup, chatGroupMap, onFileDropOnChat,
    expanded = true, onToggleExpand,
}: Props) {
    const [showAddModal, setShowAddModal] = useState(false);
    const activeChatId = activeView.type === 'chat' ? activeView.chatId : null;

    // Chat drag-reorder state (folder reorder pattern: Sidebar.tsx:128-219).
    const [dragOverChatId, setDragOverChatId] = useState<number | null>(null);
    const [dragOverPosition, setDragOverPosition] = useState<'above' | 'below' | null>(null);

    const handleChatDragOver = useCallback((e: React.DragEvent, chatId: number) => {
        if (!e.dataTransfer.types.includes(CHAT_REORDER_MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        const rect = e.currentTarget.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        setDragOverChatId(chatId);
        setDragOverPosition(e.clientY < midY ? 'above' : 'below');
    }, []);

    const handleChatDrop = useCallback((e: React.DragEvent) => {
        const reorderData = e.dataTransfer.getData(CHAT_REORDER_MIME);
        if (!reorderData || dragOverChatId === null || dragOverPosition === null) return;
        const draggedId = Number(reorderData);
        if (draggedId === dragOverChatId) {
            setDragOverChatId(null);
            setDragOverPosition(null);
            return;
        }
        const draggedIndex = chats.findIndex(c => c.chat_id === draggedId);
        if (draggedIndex === -1) return;
        const targetIndex = chats.findIndex(c => c.chat_id === dragOverChatId);
        if (targetIndex === -1) return;

        const reordered = [...chats];
        const [draggedItem] = reordered.splice(draggedIndex, 1);
        const newTargetIndex = reordered.findIndex(c => c.chat_id === dragOverChatId);
        reordered.splice(dragOverPosition === 'above' ? newTargetIndex : newTargetIndex + 1, 0, draggedItem);
        onReorder(reordered);
        setDragOverChatId(null);
        setDragOverPosition(null);
    }, [chats, dragOverChatId, dragOverPosition, onReorder]);

    const handleDragEnd = useCallback(() => {
        setDragOverChatId(null);
        setDragOverPosition(null);
    }, []);

    return (
        <>
            {/* Section header — collapsible (PublicChannelSidebarSection pattern) */}
            {!collapsed && (
                <div className="flex items-center justify-between px-1 pt-3 pb-1 shrink-0">
                    <button
                        onClick={onToggleExpand}
                        className="flex items-center gap-1.5 text-xs font-semibold text-nobuf-subtext uppercase tracking-wider hover:text-nobuf-text transition-colors text-left flex-1"
                    >
                        {expanded
                            ? <ChevronDown className="w-3.5 h-3.5 shrink-0 transition-transform" />
                            : <ChevronRight className="w-3.5 h-3.5 shrink-0 transition-transform" />}
                        <span>Chats</span>
                        {chats.length > 0 && (
                            <span className="text-[10px] font-normal text-nobuf-subtext/60 bg-nobuf-hover px-1.5 py-0.5 rounded-full">
                                {chats.length}
                            </span>
                        )}
                    </button>
                    <button
                        onClick={() => setShowAddModal(true)}
                        className="text-nobuf-subtext hover:text-nobuf-primary transition-colors shrink-0 ml-1"
                        title="Add a chat"
                    >
                        <Plus className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}

            {/* Collapsed rail — just the + icon */}
            {collapsed && (
                <div className="px-4 pt-3 pb-1 shrink-0 flex justify-center">
                    <button
                        onClick={() => setShowAddModal(true)}
                        className="w-8 h-8 flex items-center justify-center rounded-lg text-nobuf-subtext hover:text-nobuf-primary hover:bg-nobuf-hover transition-colors"
                        title="Add a chat"
                    >
                        <Plus className="w-4 h-4" />
                    </button>
                </div>
            )}

            {/* Chat list — conditional render (no max-h clipping) */}
            {(expanded || collapsed) && (
                <div className={`flex flex-col gap-0.5 ${collapsed ? 'px-0' : 'px-3'} pb-2`}>
                    {chats.map(chat => (
                        <ChatItem
                            key={chat.chat_id}
                            chat={chat}
                            active={activeChatId === chat.chat_id}
                            collapsed={collapsed}
                            onClick={() => onSelect(chat.chat_id)}
                            onRemove={() => onRemove(chat.chat_id, chat.title)}
                            onHideInVault={onHideInVault ? () => onHideInVault(chat.chat_id) : undefined}
                            onAssignGroup={onAssignGroup ? (groupId) => onAssignGroup(chat.chat_id, groupId) : undefined}
                            currentGroupId={chatGroupMap[chat.chat_id]?.id ?? null}
                            groupColor={chatGroupMap[chat.chat_id]?.color ?? null}
                            onChatDragOver={(e) => handleChatDragOver(e, chat.chat_id)}
                            onChatDragLeave={() => { setDragOverChatId(null); setDragOverPosition(null); }}
                            onChatDrop={handleChatDrop}
                            onChatDragEnd={handleDragEnd}
                            reorderIndicator={dragOverChatId === chat.chat_id ? dragOverPosition : null}
                            onFileDrop={onFileDropOnChat ? (e) => onFileDropOnChat(chat.chat_id, e) : undefined}
                        />
                    ))}
                    {!collapsed && chats.length === 0 && (
                        <div className="px-3 py-2 text-xs text-nobuf-subtext">
                            No chats added.
                        </div>
                    )}
                </div>
            )}

            <AddChatModal
                open={showAddModal}
                onClose={() => setShowAddModal(false)}
                onAdded={onAdded}
            />
        </>
    );
}
