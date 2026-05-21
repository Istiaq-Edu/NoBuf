import { useState, useMemo, useCallback, useRef, useEffect, type RefCallback } from 'react';
import { Plus, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { FileCard } from './FileCard';
import { EmptyState } from './EmptyState';
import { TelegramFile } from '../../types';
import { ContextMenu } from './ContextMenu';
import { FileListItem } from './FileListItem';
import { useSettings, GridDensity, SortField } from '../../context/SettingsContext';

interface FileExplorerProps {
    files: TelegramFile[];
    loading: boolean;
    error: Error | null;
    viewMode: 'grid' | 'list';
    selectedIds: number[];
    activeFolderId: number | null;
    onFileClick: (e: React.MouseEvent, id: number) => void;
    onDelete: (id: number) => void;
    onDownload: (id: number, name: string) => void;
    onPreview: (file: TelegramFile, orderedFiles?: TelegramFile[]) => void;
    onManualUpload: () => void;
    onSelectionClear: () => void;
    onToggleSelection: (id: number) => void;
    onDrop?: (e: React.DragEvent, folderId: number) => void;
    onDragStart?: (fileId: number) => void;
    onDragEnd?: () => void;
}


const MIN_CARD_WIDTH: Record<GridDensity, number> = {
    compact: 140,
    default: 200,
    spacious: 280,
};
/** Max columns per density — compact gets more columns in fullscreen */
const MAX_COLS: Record<GridDensity, number> = {
    compact: 12,
    default: 8,
    spacious: 6,
};
const GAP = 6;

/** Pure calculation — exported for testing */
export function calculateColumns(containerWidth: number, gap: number, minWidth: number, maxCols: number): number {
    if (containerWidth <= 0 || minWidth <= 0) return 1;
    return Math.min(maxCols, Math.max(1, Math.floor((containerWidth + gap) / (minWidth + gap))));
}

/**
 * Grid layout hook — callback ref for immediate mount, ResizeObserver with
 * direct gating (no debounce — ResizeObserver already batches per-frame).
 *
 * Industry pattern (Google Photos, Apple Photos, Notion):
 *   - ResizeObserver fires → gate on actual column change → React skips
 *     re-render if value is identical (React 18 Object.is)
 *   - animateShift flag controls CSS transition window for smooth column shifts
 *   - rAF used only to break potential observer→layout→observer loops
 */
function useGridColumns(density: GridDensity) {
    const elRef = useRef<HTMLDivElement | null>(null);
    const roRef = useRef<ResizeObserver | null>(null);
    const [columns, setColumns] = useState(4);
    const densityRef = useRef(density);
    densityRef.current = density;
    const animTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [animateShift, setAnimateShift] = useState(false);
    const mountedRef = useRef(false);

    // Animate whenever columns actually change (skip first render)
    useEffect(() => {
        if (!mountedRef.current) { mountedRef.current = true; return; }
        setAnimateShift(true);
        clearTimeout(animTimerRef.current);
        animTimerRef.current = setTimeout(() => setAnimateShift(false), 280);
        return () => clearTimeout(animTimerRef.current);
    }, [columns]);

    // Direct gating — ResizeObserver already batches per-frame, no debounce needed.
    // React 18 skips re-render when setColumns receives the same value (Object.is).
    const updateColumns = useCallback(() => {
        const el = elRef.current;
        if (!el) return;
        const d = densityRef.current;
        const nextCols = calculateColumns(el.clientWidth, GAP, MIN_CARD_WIDTH[d], MAX_COLS[d]);
        setColumns(prev => prev === nextCols ? prev : nextCols);
    }, []);

    // Callback ref — fires synchronously when the element mounts/unmounts
    const containerRef: RefCallback<HTMLDivElement> = useCallback((el) => {
        roRef.current?.disconnect();
        elRef.current = el;
        if (el) {
            updateColumns(); // first paint — synchronous
            const ro = new ResizeObserver(() => {
                // rAF breaks potential observer→layout→observer loops
                requestAnimationFrame(() => updateColumns());
            });
            ro.observe(el);
            roRef.current = ro;
        }
    }, [updateColumns]);

    // Recalculate when density changes (immediate)
    useEffect(() => { updateColumns(); }, [density, updateColumns]);

    // Cleanup on unmount
    useEffect(() => () => { clearTimeout(animTimerRef.current); }, []);

    return { columns, containerRef, scrollRef: elRef, animateShift };
}

export function FileExplorer({
    files, loading, error, viewMode, selectedIds, activeFolderId,
    onFileClick, onDelete, onDownload, onPreview, onManualUpload, onSelectionClear, onToggleSelection, onDrop, onDragStart, onDragEnd
}: FileExplorerProps) {
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: TelegramFile } | null>(null);
    const { settings, updateSetting } = useSettings();
    const { columns, containerRef, scrollRef, animateShift } = useGridColumns(settings.gridDensity);

    const sortField = settings.sortField;
    const sortDirection = settings.sortDirection;

    // Measure actual row height from the DOM for the virtualizer.
    // Uses rAF batching (industry standard) to break observer→layout→observer loops.
    // Ref updates immediately; state update is batched to next frame.
    const rowHeightRef = useRef(200);
    const [rowHeight, setRowHeight] = useState(200);
    const rowRafRef = useRef<number>(0);

    const handleRowMount = useCallback((el: HTMLDivElement | null) => {
        if (!el) return;
        const ro = new ResizeObserver(([entry]) => {
            const h = entry.contentRect.height;
            if (h > 0 && Math.abs(h - rowHeightRef.current) > 1) {
                rowHeightRef.current = h; // ref is always accurate
                cancelAnimationFrame(rowRafRef.current);
                rowRafRef.current = requestAnimationFrame(() => {
                    setRowHeight(h + GAP); // state update batched to next frame
                });
            }
        });
        ro.observe(el);
        return () => {
            ro.disconnect();
            cancelAnimationFrame(rowRafRef.current);
        };
    }, []);

    // Cleanup rAF on unmount
    useEffect(() => () => { cancelAnimationFrame(rowRafRef.current); }, []);

    const handleContextMenu = useCallback((e: React.MouseEvent, file: TelegramFile) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY, file });
    }, []);

    const sortedFiles = useMemo(() => {
        return [...files].sort((a, b) => {
            let comparison = 0;
            switch (sortField) {
                case 'name':
                    comparison = a.name.localeCompare(b.name);
                    break;
                case 'size':
                    comparison = (a.size || 0) - (b.size || 0);
                    break;
                case 'date':
                    comparison = (a.created_at || '').localeCompare(b.created_at || '');
                    break;
            }
            return sortDirection === 'asc' ? comparison : -comparison;
        });
    }, [files, sortField, sortDirection]);

    const handlePreviewRequest = useCallback((file: TelegramFile) => {
        onPreview(file, sortedFiles);
    }, [onPreview, sortedFiles]);


    const gridRows = useMemo(() => {
        const rows: TelegramFile[][] = [];
        for (let i = 0; i < sortedFiles.length; i += columns) {
            rows.push(sortedFiles.slice(i, i + columns));
        }
        return rows;
    }, [sortedFiles, columns]);


    const listItems = useMemo(() => {
        return sortedFiles;
    }, [sortedFiles]);


    const gridVirtualizer = useVirtualizer({
        count: gridRows.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: useCallback(() => rowHeight, [rowHeight]),
        overscan: 2,
        gap: GAP,
    });


    useEffect(() => {
        gridVirtualizer.measure();
    }, [rowHeight, columns, gridVirtualizer]);

    const listVirtualizer = useVirtualizer({
        count: listItems.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 48,
        overscan: 5,
    });

    const handleSort = (field: SortField) => {
        if (sortField === field) {
            updateSetting('sortDirection', sortDirection === 'asc' ? 'desc' : 'asc');
        } else {
            updateSetting('sortField', field);
            updateSetting('sortDirection', 'asc');
        }
    };

    const SortIcon = ({ field }: { field: SortField }) => {
        if (sortField !== field) return <ArrowUpDown className="w-3 h-3 opacity-30" />;
        return sortDirection === 'asc'
            ? <ArrowUp className="w-3 h-3 text-telegram-primary" />
            : <ArrowDown className="w-3 h-3 text-telegram-primary" />;
    };

    if (loading) {
        return (
            <div className="flex-1 p-6 flex justify-center items-center text-telegram-subtext flex-col gap-4">
                <div className="w-8 h-8 border-4 border-telegram-primary border-t-transparent rounded-full animate-spin"></div>
                Loading your files...
            </div>
        )
    }

    if (error) {
        return <div className="flex-1 p-6 flex justify-center items-center text-red-400">Error loading files</div>
    }

    if (files.length === 0) {
        return (
            <div className="flex-1 p-6 overflow-auto">
                <EmptyState onUpload={onManualUpload} />
            </div>
        );
    }

    return (
        <div
            ref={containerRef}
            className="flex-1 px-6 pb-6 overflow-auto custom-scrollbar"
            style={{ willChange: 'scroll-position' }}
            onClick={(e) => {
                if (e.target === e.currentTarget) onSelectionClear();
            }}
        >
            {viewMode === 'grid' ? (
                <>

                    <div className="sticky top-0 z-10 bg-telegram-bg flex items-center justify-between px-4 pt-3 pb-2 text-xs text-telegram-subtext border-b border-telegram-border select-none">
                        <div className="flex items-center gap-2">
                            <span className="font-semibold">Sort by:</span>
                            <button
                                onClick={() => handleSort('name')}
                                className={`px-2 py-1 rounded flex items-center gap-1 hover:bg-white/5 ${sortField === 'name' ? 'text-telegram-primary' : ''}`}
                            >
                                Name <SortIcon field="name" />
                            </button>
                            <button
                                onClick={() => handleSort('size')}
                                className={`px-2 py-1 rounded flex items-center gap-1 hover:bg-white/5 ${sortField === 'size' ? 'text-telegram-primary' : ''}`}
                            >
                                Size <SortIcon field="size" />
                            </button>
                            <button
                                onClick={() => handleSort('date')}
                                className={`px-2 py-1 rounded flex items-center gap-1 hover:bg-white/5 ${sortField === 'date' ? 'text-telegram-primary' : ''}`}
                            >
                                Date <SortIcon field="date" />
                            </button>
                        </div>
                        <button
                            onClick={(e) => { e.stopPropagation(); onManualUpload(); }}
                            className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium bg-telegram-primary text-black hover:brightness-110 active:scale-95 transition-all"
                        >
                            <Plus className="w-3.5 h-3.5" />
                            Upload
                        </button>
                    </div>


                    <div
                        className="relative w-full"
                        style={{ height: `${gridVirtualizer.getTotalSize()}px` }}
                    >
                        {gridVirtualizer.getVirtualItems().map((virtualRow, vIdx) => {
                            const row = gridRows[virtualRow.index];
                            return (
                                <div
                                    key={virtualRow.key}
                                    ref={vIdx === 0 ? handleRowMount : undefined}
                                    className="absolute top-0 left-0 w-full grid"
                                    style={{
                                        transform: `translateY(${virtualRow.start}px)`,
                                        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                                        gap: `${GAP}px`,
                                        contain: 'layout style paint',
                                        ...(animateShift ? {
                                            transition: 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)',
                                        } : {}),
                                    }}
                                >
                                    {row.map((file) => {
                                        return (
                                                <FileCard
                                                key={file.id}
                                                file={file}
                                                isSelected={selectedIds.includes(file.id)}
                                                onClick={(e) => onFileClick(e, file.id)}
                                                onContextMenu={(e) => handleContextMenu(e, file)}
                                                onDelete={() => onDelete(file.id)}
                                                onDownload={() => onDownload(file.id, file.name)}
                                                onDrop={onDrop}
                                                onDragStart={onDragStart}
                                                onDragEnd={onDragEnd}
                                                activeFolderId={activeFolderId}
                                                onToggleSelection={() => onToggleSelection(file.id)}
                                            />
                                        );
                                    })}
                                </div>
                            );
                        })}
                    </div>
                </>
            ) : (
                <div className="flex flex-col w-full">
                    {/* List Header — pinned */}
                    <div className="sticky top-0 z-10 bg-telegram-bg grid grid-cols-[2.5rem_2fr_6rem_8rem] gap-4 px-4 pt-3 pb-2 text-xs font-semibold text-telegram-subtext border-b border-telegram-border select-none items-center">
                        <div className="text-center">#</div>
                        <div className="flex items-center justify-between">
                            <button onClick={() => handleSort('name')} className="flex items-center gap-1 hover:text-telegram-text transition-colors">
                                Name <SortIcon field="name" />
                            </button>
                            <button
                                onClick={(e) => { e.stopPropagation(); onManualUpload(); }}
                                className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium bg-telegram-primary text-black hover:brightness-110 active:scale-95 transition-all"
                            >
                                <Plus className="w-3.5 h-3.5" />
                                Upload
                            </button>
                        </div>
                        <button onClick={() => handleSort('size')} className="flex items-center gap-1 justify-end hover:text-telegram-text transition-colors">
                            Size <SortIcon field="size" />
                        </button>
                        <button onClick={() => handleSort('date')} className="flex items-center gap-1 justify-end hover:text-telegram-text transition-colors">
                            Date <SortIcon field="date" />
                        </button>
                    </div>


                    <div
                        className="relative w-full"
                        style={{ height: `${listVirtualizer.getTotalSize()}px` }}
                    >
                        {listVirtualizer.getVirtualItems().map((virtualItem) => {
                            const file = listItems[virtualItem.index];
                            return (
                                <div
                                    key={file.id}
                                    className="absolute top-0 left-0 w-full"
                                    style={{ transform: `translateY(${virtualItem.start}px)` }}
                                >
                                    <FileListItem
                                        file={file}
                                        selectedIds={selectedIds}
                                        onFileClick={onFileClick}
                                        handleContextMenu={handleContextMenu}
                                        onDragStart={onDragStart}
                                        onDragEnd={onDragEnd}
                                        onDrop={onDrop}
                                        onToggleSelection={onToggleSelection}
                                        onDownload={onDownload}
                                        onDelete={onDelete}
                                    />
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    file={contextMenu.file}
                    onClose={() => setContextMenu(null)}
                    onDownload={() => {
                        onDownload(contextMenu.file.id, contextMenu.file.name);
                        setContextMenu(null);
                    }}
                    onDelete={() => {
                        onDelete(contextMenu.file.id);
                        setContextMenu(null);
                    }}
                    onPreview={() => {
                        if (contextMenu.file.type === 'folder') {
                            onFileClick({ preventDefault: () => { }, stopPropagation: () => { } } as React.MouseEvent, contextMenu.file.id);
                        } else {
                            handlePreviewRequest(contextMenu.file);
                        }
                        setContextMenu(null);
                    }}
                />
            )}
        </div>
    )
}
