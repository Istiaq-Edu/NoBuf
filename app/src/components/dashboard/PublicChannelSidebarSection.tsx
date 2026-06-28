import { useState } from 'react';
import { Plus, ChevronDown, ChevronRight } from 'lucide-react';
import { PublicChannel, ActiveView } from '../../types';
import { PublicChannelItem } from './PublicChannelItem';
import { AddChannelModal } from './AddChannelModal';

interface Props {
    channels: PublicChannel[];
    activeView: ActiveView;
    collapsed: boolean;
    onSelect: (channelId: number) => void;
    onRemoved: () => void;
    onRemove?: (channelId: number) => void;
    expanded?: boolean;
    onToggleExpand?: () => void;
}

export function PublicChannelSidebarSection({ channels, activeView, collapsed, onSelect, onRemoved, onRemove, expanded = true, onToggleExpand }: Props) {
    const [showAddModal, setShowAddModal] = useState(false);
    const activeChannelId = activeView.type === 'public' ? activeView.channelId : null;

    return (
        <>
            {/* Section header — chevron + label + count + add button */}
            {!collapsed && (
                <div className="flex items-center justify-between px-1 pt-3 pb-1 shrink-0">
                    <button
                        onClick={onToggleExpand}
                        className="flex items-center gap-1.5 text-xs font-semibold text-nobuf-subtext uppercase tracking-wider hover:text-nobuf-text transition-colors text-left flex-1"
                    >
                        {expanded
                            ? <ChevronDown className="w-3.5 h-3.5 shrink-0 transition-transform" />
                            : <ChevronRight className="w-3.5 h-3.5 shrink-0 transition-transform" />
                        }
                        <span>Public Channels</span>
                        {channels.length > 0 && (
                            <span className="text-[10px] font-normal text-nobuf-subtext/60 bg-nobuf-hover px-1.5 py-0.5 rounded-full">
                                {channels.length}
                            </span>
                        )}
                    </button>
                    <button
                        onClick={() => setShowAddModal(true)}
                        className="text-nobuf-subtext hover:text-nobuf-primary transition-colors shrink-0 ml-1"
                        title="Add public channel"
                    >
                        <Plus className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}

            {/* Collapsed sidebar — just the + icon */}
            {collapsed && (
                <div className="px-4 pt-3 pb-1 shrink-0">
                    <button
                        onClick={() => setShowAddModal(true)}
                        className="text-nobuf-subtext hover:text-nobuf-primary transition-colors"
                        title="Add public channel"
                    >
                        <Plus className="w-4 h-4" />
                    </button>
                </div>
            )}

            {/* Channel list — conditional render (no max-h clipping) */}
                        {expanded && !collapsed && (
                            <div className="flex flex-col gap-0.5 px-3 pb-2">
                                {channels.map(channel => (
                                    <PublicChannelItem
                                        key={channel.channel_id}
                                        channel={channel}
                                        active={activeChannelId === channel.channel_id}
                                        collapsed={collapsed}
                                        onClick={() => onSelect(channel.channel_id)}
                                        onRemove={() => {
                                            if (onRemove) {
                                                onRemove(channel.channel_id);
                                            }
                                        }}
                                    />
                                ))}
                                {channels.length === 0 && (
                                    <div className="px-3 py-2 text-xs text-nobuf-subtext">
                                        No public channels added.
                                    </div>
                                )}
                            </div>
                        )}

            <AddChannelModal
                open={showAddModal}
                onClose={() => setShowAddModal(false)}
                onAdded={onRemoved}
            />
        </>
    );
}