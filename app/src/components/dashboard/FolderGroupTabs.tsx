import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X } from 'lucide-react';
import {
    DndContext, closestCenter, KeyboardSensor, PointerSensor,
    useSensor, useSensors, DragEndEvent,
} from '@dnd-kit/core';
import {
    SortableContext, sortableKeyboardCoordinates, horizontalListSortingStrategy,
    useSortable, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface FolderGroup {
    id: number;
    name: string;
    color_hex: string;
    display_order: number;
}

interface SortableChipProps {
    group: FolderGroup;
    isActive: boolean;
    onClick: () => void;
    onDelete: () => void;
}

function SortableChip({ group, isActive, onClick, onDelete }: SortableChipProps) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: group.id });
    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
    };

    return (
        <div
            ref={setNodeRef}
            style={{
                ...style,
                ...(isActive ? {
                    backgroundColor: group.color_hex,
                    borderColor: group.color_hex,
                    color: '#ffffff',
                } : {
                    backgroundColor: 'transparent',
                    borderColor: 'rgba(128,128,128,0.25)',
                    color: 'var(--color-nobuf-subtext)',
                }),
            }}
            className={`group/chip flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold cursor-pointer whitespace-nowrap transition-all duration-200 border ${isActive ? '' : 'hover:border-nobuf-subtext/40 hover:text-nobuf-text'}`}
            onClick={onClick}
            {...attributes}
            {...listeners}
        >
            <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: group.color_hex }}
            />
            <span>{group.name}</span>
            <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="opacity-0 group-hover/chip:opacity-100 p-0.5 rounded-full hover:bg-black/20 transition-all duration-200"
            >
                <X className="w-3 h-3" />
            </button>
        </div>
    );
}

interface FolderGroupTabsProps {
    activeGroupId: number | null;
    onGroupSelect: (id: number | null) => void;
    refreshKey: number;
}

export function FolderGroupTabs({ activeGroupId, onGroupSelect, refreshKey }: FolderGroupTabsProps) {
    const [groups, setGroups] = useState<FolderGroup[]>([]);
    const scrollRef = useRef<HTMLDivElement>(null);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    const fetchGroups = useCallback(async () => {
        try {
            const result = await invoke<FolderGroup[]>('cmd_get_groups');
            setGroups(result);
        } catch {}
    }, []);

    useEffect(() => { fetchGroups(); }, [fetchGroups, refreshKey]);

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const oldIndex = groups.findIndex(g => g.id === active.id);
        const newIndex = groups.findIndex(g => g.id === over.id);
        const reordered = arrayMove(groups, oldIndex, newIndex);
        setGroups(reordered);
        const orders = reordered.map((g, i) => [g.id, i] as [number, number]);
        invoke('cmd_update_group_order', { groupOrders: orders }).catch(() => {});
    };

    const handleDelete = async (id: number) => {
        try {
            await invoke('cmd_delete_group', { id });
            if (activeGroupId === id) onGroupSelect(null);
            fetchGroups();
        } catch {}
    };

    // Mouse wheel → horizontal scroll
    const handleWheel = (e: React.WheelEvent) => {
        if (scrollRef.current) {
            scrollRef.current.scrollLeft += e.deltaY;
        }
    };

    if (groups.length === 0) return null;

    return (
        <div
            ref={scrollRef}
            onWheel={handleWheel}
            className="flex items-center gap-2 px-2 py-2 overflow-x-auto group-tabs-scroll"
        >
            {/* "All" chip */}
            <div
                className={`px-3 py-1 rounded-full text-xs font-semibold cursor-pointer whitespace-nowrap transition-all duration-200 border ${
                    activeGroupId === null
                        ? 'bg-nobuf-primary text-white border-nobuf-primary'
                        : 'bg-transparent border-nobuf-border/60 text-nobuf-subtext hover:border-nobuf-subtext/40 hover:text-nobuf-text'
                }`}
                onClick={() => onGroupSelect(null)}
            >
                All
            </div>

            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={groups.map(g => g.id)} strategy={horizontalListSortingStrategy}>
                    {groups.map(group => (
                        <SortableChip
                            key={group.id}
                            group={group}
                            isActive={activeGroupId === group.id}
                            onClick={() => onGroupSelect(activeGroupId === group.id ? null : group.id)}
                            onDelete={() => handleDelete(group.id)}
                        />
                    ))}
                </SortableContext>
            </DndContext>
        </div>
    );
}
