import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { TelegramFolder, ChatInfo, ForwardResult } from '../../types';

interface Props {
    open: boolean;
    onClose: () => void;
    sourceChannelId: number;
    selectedFileIds: number[];
    folders: TelegramFolder[];
    /** Chat targets (D17): targetFolderId = chatId through the mirrored-id seam. */
    chats: ChatInfo[];
    /** Current chat view id (source exclusion — F-B3/V2-08 parity). */
    sourceChatId?: number | null;
    onForwarded: () => void;
}

/** Target shape: a folder OR a chat (both dispatch through
 *  cmd_forward_to_folder — targetFolderId carries the chat id). */
type Target = { id: number; name: string; isChat: boolean };

export function ForwardToFolderModal({ open, onClose, sourceChannelId, selectedFileIds, folders, chats, sourceChatId, onForwarded }: Props) {
    const [selectedTarget, setSelectedTarget] = useState<Target | null>(null);
    const [forwarding, setForwarding] = useState(false);
    const [progress, setProgress] = useState(0);

    if (!open) return null;

    const handleForward = async () => {
        if (!selectedTarget) return;
        setForwarding(true);
        setProgress(10);
        try {
            const messageIds = selectedFileIds.map(id => id as number);
            
            setProgress(30);
            const result = await invoke<ForwardResult>('cmd_forward_to_folder', {
                sourceChannelId,
                messageIds,
                targetFolderId: selectedTarget.id,
            });
            
            setProgress(100);
            if (result.success) {
                toast.success(`Forwarded ${result.forwarded_count} file(s) to ${selectedTarget.name}.`);
            } else {
                toast.warning(`Forwarded ${result.forwarded_count} file(s) with ${result.errors.length} error(s).`);
                result.errors.forEach(e => toast.error(e));
            }
            onForwarded();
            handleClose();
        } catch (e: any) {
            toast.error(String(e));
        } finally {
            setForwarding(false);
            setProgress(0);
        }
    };

    const handleClose = () => {
        setSelectedTarget(null);
        setProgress(0);
        onClose();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={handleClose}>
            <div
                className="bg-nobuf-bg rounded-2xl border border-nobuf-border w-full max-w-md"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-4 border-b border-nobuf-border">
                    <h3 className="font-semibold text-nobuf-text">
                        Forward to Folder
                        <span className="block text-xs font-normal text-nobuf-subtext mt-0.5">
                            {selectedFileIds.length} file(s) selected
                        </span>
                    </h3>
                    <button onClick={handleClose} className="text-nobuf-subtext hover:text-nobuf-text">✕</button>
                </div>

                <div className="p-4 space-y-2 max-h-80 overflow-y-auto sidebar-scroll">
                    {folders.length === 0 && chats.length === 0 && (
                        <div className="text-center py-6 text-sm text-nobuf-subtext">
                            No destinations available.
                        </div>
                    )}
                    {folders.map(folder => (
                        <div
                            key={`f-${folder.id}`}
                            onClick={() => setSelectedTarget({ id: folder.id, name: folder.name, isChat: false })}
                            className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                                selectedTarget?.id === folder.id && !selectedTarget.isChat
                                    ? 'border-nobuf-primary bg-nobuf-primary/10'
                                    : 'border-nobuf-border hover:bg-nobuf-hover'
                            }`}
                        >
                            <div className="w-8 h-8 rounded-lg bg-nobuf-primary/20 flex items-center justify-center shrink-0">
                                <span className="text-nobuf-primary text-xs font-bold">📁</span>
                            </div>
                            <span className="text-sm font-medium text-nobuf-text truncate">{folder.name}</span>
                            {selectedTarget?.id === folder.id && !selectedTarget.isChat && (
                                <span className="ml-auto text-nobuf-primary text-sm">✓</span>
                            )}
                        </div>
                    ))}
                    {chats.filter(chat => chat.chat_id !== sourceChatId).map(chat => (
                        <div
                            key={`c-${chat.chat_id}`}
                            onClick={() => setSelectedTarget({ id: chat.chat_id, name: chat.title, isChat: true })}
                            className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                                selectedTarget?.id === chat.chat_id && selectedTarget.isChat
                                    ? 'border-nobuf-primary bg-nobuf-primary/10'
                                    : 'border-nobuf-border hover:bg-nobuf-hover'
                            }`}
                        >
                            <div className="w-8 h-8 rounded-lg bg-blue-500/15 flex items-center justify-center shrink-0">
                                <span className="text-blue-400 text-xs font-bold">{chat.title.charAt(0).toUpperCase()}</span>
                            </div>
                            <div className="min-w-0">
                                <div className="text-sm font-medium text-nobuf-text truncate">{chat.title}</div>
                                <div className="text-[10px] text-nobuf-subtext">Chat</div>
                            </div>
                            {selectedTarget?.id === chat.chat_id && selectedTarget.isChat && (
                                <span className="ml-auto text-nobuf-primary text-sm">✓</span>
                            )}
                        </div>
                    ))}
                </div>

                {progress > 0 && (
                    <div className="px-4 pb-2">
                        <div className="w-full h-1.5 bg-nobuf-hover rounded-full overflow-hidden">
                            <div
                                className="h-full bg-nobuf-primary transition-all duration-300"
                                style={{ width: `${progress}%` }}
                            />
                        </div>
                    </div>
                )}

                <div className="flex gap-2 p-4 border-t border-nobuf-border">
                    <button
                        onClick={handleClose}
                        disabled={forwarding}
                        className="flex-1 py-2.5 rounded-lg border border-nobuf-border text-nobuf-text text-sm font-medium hover:bg-nobuf-hover transition-colors disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleForward}
                        disabled={!selectedTarget || forwarding}
                        className="flex-1 py-2.5 rounded-lg bg-nobuf-primary text-white text-sm font-medium hover:bg-nobuf-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {forwarding ? 'Forwarding...' : `Forward ${selectedFileIds.length} file(s)`}
                    </button>
                </div>
            </div>
        </div>
    );
}
