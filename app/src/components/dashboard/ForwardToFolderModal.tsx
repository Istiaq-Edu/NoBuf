import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { TelegramFolder, ForwardResult } from '../../types';

interface Props {
    open: boolean;
    onClose: () => void;
    sourceChannelId: number;
    selectedFileIds: number[];
    folders: TelegramFolder[];
    onForwarded: () => void;
}

export function ForwardToFolderModal({ open, onClose, sourceChannelId, selectedFileIds, folders, onForwarded }: Props) {
    const [selectedFolder, setSelectedFolder] = useState<TelegramFolder | null>(null);
    const [forwarding, setForwarding] = useState(false);
    const [progress, setProgress] = useState(0);

    if (!open) return null;

    const handleForward = async () => {
        if (!selectedFolder) return;
        setForwarding(true);
        setProgress(10);
        try {
            const messageIds = selectedFileIds.map(id => id as number);
            
            setProgress(30);
            const result = await invoke<ForwardResult>('cmd_forward_to_folder', {
                sourceChannelId,
                messageIds,
                targetFolderId: selectedFolder.id,
            });
            
            setProgress(100);
            if (result.success) {
                toast.success(`Forwarded ${result.forwarded_count} file(s) to ${selectedFolder.name}.`);
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
        setSelectedFolder(null);
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
                    {folders.length === 0 && (
                        <div className="text-center py-6 text-sm text-nobuf-subtext">
                            No NoBuf folders available. Create a folder first.
                        </div>
                    )}
                    {folders.map(folder => (
                        <div
                            key={folder.id}
                            onClick={() => setSelectedFolder(folder)}
                            className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                                selectedFolder?.id === folder.id
                                    ? 'border-nobuf-primary bg-nobuf-primary/10'
                                    : 'border-nobuf-border hover:bg-nobuf-hover'
                            }`}
                        >
                            <div className="w-8 h-8 rounded-lg bg-nobuf-primary/20 flex items-center justify-center shrink-0">
                                <span className="text-nobuf-primary text-xs font-bold">📁</span>
                            </div>
                            <span className="text-sm font-medium text-nobuf-text truncate">{folder.name}</span>
                            {selectedFolder?.id === folder.id && (
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
                        disabled={!selectedFolder || forwarding}
                        className="flex-1 py-2.5 rounded-lg bg-nobuf-primary text-white text-sm font-medium hover:bg-nobuf-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {forwarding ? 'Forwarding...' : `Forward ${selectedFileIds.length} file(s)`}
                    </button>
                </div>
            </div>
        </div>
    );
}
