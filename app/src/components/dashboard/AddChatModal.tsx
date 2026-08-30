import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Loader2, Search, X, Check } from 'lucide-react';
import { PickableChat, ChatInfo } from '../../types';

interface Props {
    open: boolean;
    onClose: () => void;
    onAdded: (chat: ChatInfo) => void;
}

/**
 * Chat picker modal (plan F2, D3): single view — search + eligible dialog
 * list. Already-added chats render disabled with a green check. Adding calls
 * cmd_add_chat directly (no parent handler hop — the caller supplies onAdded
 * for state push, the AddChannelModal-adopt pattern).
 */
export function AddChatModal({ open, onClose, onAdded }: Props) {
    const [pickable, setPickable] = useState<PickableChat[]>([]);
    const [loading, setLoading] = useState(false);
    const [search, setSearch] = useState('');
    const [addingId, setAddingId] = useState<number | null>(null);
    const [fetched, setFetched] = useState(false);

    useEffect(() => {
        if (open && !fetched) {
            setLoading(true);
            invoke<PickableChat[]>('cmd_pick_chats')
                .then(setPickable)
                .catch((e) => toast.error(`Failed to list chats: ${e}`))
                .finally(() => setLoading(false));
            setFetched(true);
        }
        if (!open) {
            setSearch('');
            setFetched(false);
        }
    }, [open, fetched]);

    if (!open) return null;

    const handleAdd = async (chat: PickableChat) => {
        if (chat.already_added || addingId !== null) return;
        setAddingId(chat.chat_id);
        try {
            const added = await invoke<ChatInfo>('cmd_add_chat', {
                chatId: chat.chat_id,
                peerKind: chat.peer_kind,
                accessHash: chat.access_hash,
                title: chat.title,
            });
            setPickable(prev => prev.map(p => p.chat_id === chat.chat_id ? { ...p, already_added: true } : p));
            onAdded(added);
            toast.success(`"${added.title}" added to Chats.`);
        } catch (e) {
            toast.error(`Failed to add chat: ${e}`);
        } finally {
            setAddingId(null);
        }
    };

    const filtered = pickable.filter(c =>
        !search || c.title.toLowerCase().includes(search.toLowerCase())
    );

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
            onClick={onClose}
        >
            <div
                className="bg-nobuf-surface border border-nobuf-border rounded-2xl shadow-2xl w-full max-w-md max-h-[70vh] flex flex-col animate-in fade-in zoom-in-95 duration-150"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-nobuf-border">
                    <h2 className="text-base font-semibold text-nobuf-text">Add Chat</h2>
                    <button
                        onClick={onClose}
                        className="text-nobuf-subtext hover:text-nobuf-text transition-colors"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Search */}
                <div className="px-5 py-3 border-b border-nobuf-border">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-nobuf-subtext" />
                        <input
                            autoFocus
                            type="text"
                            className="w-full bg-nobuf-bg border border-nobuf-border rounded-lg pl-9 pr-3 py-2 text-sm text-nobuf-text placeholder:text-nobuf-subtext focus:outline-none focus:ring-2 focus:ring-nobuf-primary/40"
                            placeholder="Search your chats..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                    </div>
                </div>

                {/* List */}
                <div className="flex-1 overflow-y-auto px-3 py-2">
                    {loading ? (
                        <div className="flex items-center justify-center py-10 text-nobuf-subtext">
                            <Loader2 className="w-5 h-5 animate-spin mr-2" />
                            Loading chats...
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="px-3 py-10 text-center text-sm text-nobuf-subtext">
                            {pickable.length === 0
                                ? 'No eligible chats. Broadcast channels have their own flows.'
                                : 'No chats match your search.'}
                        </div>
                    ) : (
                        <div className="space-y-1">
                            {filtered.map(chat => (
                                <button
                                    key={chat.chat_id}
                                    disabled={chat.already_added}
                                    onClick={() => handleAdd(chat)}
                                    className={`w-full flex items-center gap-3 p-2.5 rounded-lg border transition-all text-left ${
                                        chat.already_added
                                            ? 'border-nobuf-border opacity-50 cursor-not-allowed'
                                            : 'border-nobuf-border hover:bg-nobuf-hover hover:border-nobuf-primary/30 cursor-pointer'
                                    }`}
                                >
                                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-nobuf-primary/60 to-blue-500/60 flex items-center justify-center shrink-0">
                                        <span className="text-white font-bold text-xs">
                                            {chat.title.charAt(0).toUpperCase()}
                                        </span>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm text-nobuf-text truncate">{chat.title}</div>
                                        <div className="text-[11px] text-nobuf-subtext">{chat.kind_label}</div>
                                    </div>
                                    {chat.already_added ? (
                                        <span className="flex items-center gap-1 text-[11px] text-green-500 shrink-0">
                                            <Check className="w-3.5 h-3.5" /> Added
                                        </span>
                                    ) : addingId === chat.chat_id ? (
                                        <Loader2 className="w-4 h-4 animate-spin text-nobuf-primary shrink-0" />
                                    ) : (
                                        <span className="text-[11px] text-nobuf-primary shrink-0">+ Add</span>
                                    )}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
