import { useState } from 'react';
import { Folder, Download, Trash2, Check } from 'lucide-react';
import { TelegramFile } from '../../types';
import { FileTypeIcon } from '../FileTypeIcon';
import { useCacheSession } from '../../context/CacheSessionContext';

interface FileListItemProps {
    file: TelegramFile;
    selectedIds: number[];
    onFileClick: (e: React.MouseEvent, id: number) => void;
    handleContextMenu: (e: React.MouseEvent, file: TelegramFile) => void;
    onDragStart?: (fileId: number) => void;
    onDragEnd?: () => void;
    onDrop?: (e: React.DragEvent, folderId: number) => void;
    onToggleSelection: (id: number) => void;
    onDownload: (id: number, name: string) => void;
    onDelete: (id: number) => void;
}

export function FileListItem({
    file, selectedIds, onFileClick, handleContextMenu,
    onDragStart, onDragEnd, onDrop,
    onToggleSelection, onDownload, onDelete
}: FileListItemProps) {
    const [isDragOver, setIsDragOver] = useState(false);
    const isFolder = file.type === 'folder';
    const cacheSession = useCacheSession();
    const cacheInfo = cacheSession.getCacheInfo(file.id);

    return (
        <div
            onClick={(e) => onFileClick(e, file.id)}
            onContextMenu={(e) => handleContextMenu(e, file)}
            draggable
            onDragStart={(e) => {
                if (onDragStart) onDragStart(file.id);
                e.dataTransfer.setData("application/x-telegram-file-id", file.id.toString());
                e.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => {
                if (onDragEnd) onDragEnd();
            }}
            onDragOver={(e) => {
                if (isFolder) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!isDragOver) setIsDragOver(true);
                }
            }}
            onDragLeave={(e) => {
                if (isFolder) {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsDragOver(false);
                }
            }}
            onDrop={(e) => {
                if (isFolder && onDrop) {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsDragOver(false);
                    onDrop(e, file.id);
                }
            }}
            className={`group grid grid-cols-[2.5rem_2fr_6rem_8rem] gap-4 items-center px-4 py-3 rounded-lg cursor-pointer border border-transparent transition-all hover:bg-nobuf-hover 
                ${selectedIds.includes(file.id) ? 'bg-nobuf-primary/10 border-nobuf-primary/20' : ''}
                ${isDragOver ? 'ring-2 ring-nobuf-primary bg-nobuf-primary/20' : ''}
            `}
        >
            <div
                className="flex items-center justify-center cursor-pointer"
                onClick={(e) => { e.stopPropagation(); onToggleSelection(file.id); }}
            >
                <div className={`w-[18px] h-[18px] rounded border-2 flex items-center justify-center transition-all ${
                    selectedIds.includes(file.id)
                        ? 'bg-nobuf-primary border-nobuf-primary'
                        : 'border-nobuf-border/60 hover:border-nobuf-subtext'
                }`}>
                    {selectedIds.includes(file.id) && <Check className="w-3 h-3 text-black" strokeWidth={3} />}
                </div>
            </div>
            <div className="truncate text-sm text-nobuf-text font-medium relative pr-8">
                <span className="inline-flex items-center gap-2">
                    {isFolder ? <Folder className="w-4 h-4 text-nobuf-primary flex-shrink-0" /> : <FileTypeIcon filename={file.name} className="w-4 h-4 flex-shrink-0" />}
                    {file.name}
                </span>
                {/* Cache session badge — green text + mini progress bar */}
                {cacheInfo && cacheInfo.percentage > 0 && !isFolder && (
                    <div className="flex items-center gap-1 mt-0.5">
                        <div className="w-16 h-[3px] bg-white/10 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-green-400 rounded-full transition-all duration-300"
                                style={{ width: `${cacheInfo.percentage}%` }}
                            />
                        </div>
                        <span className="text-[10px] font-mono text-green-400">
                            {cacheInfo.percentage >= 100 ? '100%' : `${cacheInfo.percentage}%`}
                        </span>
                    </div>
                )}
                {/* List Actions */}
                <div className="absolute right-0 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 flex items-center bg-nobuf-surface border border-nobuf-border shadow-lg rounded px-1">
                    <button onClick={(e) => { e.stopPropagation(); onDownload(file.id, file.name) }} className="p-1 hover:text-nobuf-text text-nobuf-subtext" title="Download"><Download className="w-4 h-4" /></button>
                    <button onClick={(e) => { e.stopPropagation(); onDelete(file.id) }} className="p-1 hover:text-red-400 text-nobuf-subtext" title="Delete"><Trash2 className="w-4 h-4" /></button>
                </div>
            </div>
            <div className="text-right text-xs text-nobuf-subtext truncate">{file.sizeStr}</div>
            <div className="text-right text-xs text-nobuf-subtext font-mono opacity-50 truncate">{file.created_at || '-'}</div>
        </div>
    );
}
