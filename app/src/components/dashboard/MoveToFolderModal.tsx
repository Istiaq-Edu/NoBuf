import { Plus, HardDrive, Folder, MessageCircle } from 'lucide-react';
import { TelegramFolder, ChatInfo } from '../../types';

interface MoveToFolderModalProps {
    folders: TelegramFolder[];
    chats: ChatInfo[];
    onClose: () => void;
    onSelect: (id: number | null) => void;
    activeFolderId: number | null;
    /** The chat view id when the source is a chat (V2-08: exclude it). */
    activeChatId?: number | null;
}

/** Move-target picker: folders + chats (D17). The SOURCE chat is excluded —
 *  the backend's source==target guard returns Ok(true) with no action, which
 *  would otherwise toast a lying "Moved N files." (review2 V2-08). */
export function MoveToFolderModal({ folders, chats, onClose, onSelect, activeFolderId, activeChatId }: MoveToFolderModalProps) {
    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
            <div className="bg-nobuf-surface border border-nobuf-border rounded-xl w-[calc(100vw-2rem)] max-w-80 shadow-2xl overflow-hidden flex flex-col max-h-[80vh]" onClick={e => e.stopPropagation()}>
                <div className="p-4 border-b border-nobuf-border flex justify-between items-center">
                    <h3 className="text-nobuf-text font-medium">Move to…</h3>
                    <button onClick={onClose} className="text-nobuf-subtext hover:text-nobuf-text"><Plus className="w-5 h-5 rotate-45" /></button>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1">
                    {(activeFolderId !== null || activeChatId !== null) && (
                        <button
                            onClick={() => onSelect(null)}
                            className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm text-left text-nobuf-text hover:bg-nobuf-hover transition-colors"
                        >
                            <div className="w-8 h-8 rounded bg-nobuf-primary/20 flex items-center justify-center text-nobuf-primary">
                                <HardDrive className="w-4 h-4" />
                            </div>
                            <span className="font-medium">Saved Messages</span>
                        </button>
                    )}

                    {folders.map((f: any) => {
                        if (f.id === activeFolderId) return null;
                        return (
                            <button
                                key={f.id}
                                onClick={() => onSelect(f.id)}
                                className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm text-left text-nobuf-text hover:bg-nobuf-hover transition-colors"
                            >
                                <div className="w-8 h-8 rounded bg-nobuf-hover flex items-center justify-center text-nobuf-text">
                                    <Folder className="w-4 h-4" />
                                </div>
                                <span className="font-medium">{f.name}</span>
                            </button>
                        )
                    })}

                    {chats.filter(c => c.chat_id !== activeChatId).map(c => (
                        <button
                            key={`c-${c.chat_id}`}
                            onClick={() => onSelect(c.chat_id)}
                            className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm text-left text-nobuf-text hover:bg-nobuf-hover transition-colors"
                        >
                            <div className="w-8 h-8 rounded bg-blue-500/15 flex items-center justify-center text-blue-400">
                                <MessageCircle className="w-4 h-4" />
                            </div>
                            <div className="min-w-0">
                                <div className="font-medium truncate">{c.title}</div>
                                <div className="text-[10px] text-nobuf-subtext">Chat</div>
                            </div>
                        </button>
                    ))}

                    {folders.length === 0 && chats.length === 0 && activeFolderId === null && activeChatId === null && (
                        <div className="p-4 text-center text-xs text-nobuf-subtext">No other destinations available.</div>
                    )}
                </div>
            </div>
        </div>
    )
}
