import { AlertCircle, Trash2 } from 'lucide-react';
import { PublicChannel } from '../../types';

interface Props {
    channel: PublicChannel;
    active: boolean;
    collapsed: boolean;
    onClick: () => void;
    onRemove: () => void;
}

export function PublicChannelItem({ channel, active, collapsed, onClick, onRemove }: Props) {
    return (
        <div
            className={`group flex items-center rounded-lg transition-all cursor-pointer ${
                            collapsed ? 'relative justify-center w-8 h-8' : 'px-3 gap-2.5'
                        } py-2 ${
                active
                    ? 'bg-nobuf-primary/15 text-nobuf-primary'
                    : 'text-nobuf-text hover:bg-nobuf-hover'
            }`}
            onClick={onClick}
            title={collapsed ? channel.name : undefined}
        >
            {/* Avatar circle with first letter */}
            <div className="relative shrink-0">
                            <div className={`${collapsed ? 'w-5 h-5' : 'w-6 h-6'} rounded-full flex items-center justify-center ${
                                active
                                    ? 'bg-nobuf-primary/30'
                                    : 'bg-gradient-to-br from-nobuf-primary/60 to-blue-500/60'
                            }`}>
                                <span className="text-white font-bold text-[10px]">
                                    {channel.name.charAt(0).toUpperCase()}
                                </span>
                            </div>
                            {!channel.is_member && (
                                <AlertCircle className={`absolute ${collapsed ? '-top-0.5 -right-0.5 w-2 h-2' : '-top-1 -right-1 w-2.5 h-2.5'} text-red-500 bg-nobuf-surface rounded-full`} />
                            )}
                        </div>

            {!collapsed && (
                <>
                    <div className="flex-1 min-w-0">
                        <span className="text-sm truncate block">{channel.name}</span>
                        {channel.username && (
                            <span className="text-[10px] text-nobuf-subtext truncate block">@{channel.username}</span>
                        )}
                    </div>
                    <button
                        onClick={(e) => { e.stopPropagation(); onRemove(); }}
                        className="opacity-0 group-hover:opacity-100 text-nobuf-subtext hover:text-red-500 transition-all shrink-0 p-1 rounded hover:bg-red-500/10"
                        title="Remove from NoBuf"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                </>
            )}
        </div>
    );
}