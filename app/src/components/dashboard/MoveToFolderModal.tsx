import { Plus, HardDrive, Folder } from 'lucide-react';
import { TelegramFolder } from '../../types';

interface MoveToFolderModalProps {
    folders: TelegramFolder[];
    onClose: () => void;
    onSelect: (id: number | null) => void;
    activeFolderId: number | null;
}

export function MoveToFolderModal({ folders, onClose, onSelect, activeFolderId }: MoveToFolderModalProps) {
    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
            <div className="bg-nobuf-surface border border-nobuf-border rounded-xl w-80 shadow-2xl overflow-hidden flex flex-col max-h-[80vh]" onClick={e => e.stopPropagation()}>
                <div className="p-4 border-b border-nobuf-border flex justify-between items-center">
                    <h3 className="text-nobuf-text font-medium">Move to Folder</h3>
                    <button onClick={onClose} className="text-nobuf-subtext hover:text-nobuf-text"><Plus className="w-5 h-5 rotate-45" /></button>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1">
                    {activeFolderId !== null && (
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

                    {folders.length === 0 && activeFolderId === null && (
                        <div className="p-4 text-center text-xs text-nobuf-subtext">No other folders available. Create one first!</div>
                    )}
                </div>
            </div>
        </div>
    )
}
