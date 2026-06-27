import { useState } from 'react';
import { Plus } from 'lucide-react';
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
}

export function PublicChannelSidebarSection({ channels, activeView, collapsed, onSelect, onRemoved, onRemove }: Props) {
    const [showAddModal, setShowAddModal] = useState(false);

    const activeChannelId = activeView.type === 'public' ? activeView.channelId : null;

    return (
        <>
            {!collapsed && (
                <div className="flex items-center justify-between px-3 pt-3 pb-1 shrink-0">
                    <span className="text-xs font-semibold text-nobuf-subtext uppercase tracking-wider">
                        Public Channels
                    </span>
                    <button
                        onClick={() => setShowAddModal(true)}
                        className="text-nobuf-subtext hover:text-nobuf-primary transition-colors"
                        title="Add public channel"
                    >
                        <Plus className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}
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

            <div className={`flex flex-col gap-0.5 ${collapsed ? 'px-0' : 'px-3'} pb-2`}>
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
                {!collapsed && channels.length === 0 && (
                    <div className="px-3 py-2 text-xs text-nobuf-subtext">
                        No public channels added.
                    </div>
                )}
            </div>

            <AddChannelModal
                open={showAddModal}
                onClose={() => setShowAddModal(false)}
                onAdded={onRemoved}
            />
        </>
    );
}
