import { Radio, AlertCircle } from 'lucide-react';
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
            className={`group flex items-center gap-2.5 rounded-lg transition-all cursor-pointer ${
                collapsed ? 'px-4 justify-start' : 'px-3'
            } py-2 ${
                active
                    ? 'bg-nobuf-primary/15 text-nobuf-primary'
                    : 'text-nobuf-text hover:bg-nobuf-hover'
            }`}
            onClick={onClick}
            title={collapsed ? channel.name : undefined}
        >
            <div className="relative shrink-0">
                <Radio className="w-4 h-4" />
                {!channel.is_member && (
                    <AlertCircle className="absolute -top-1 -right-1 w-2.5 h-2.5 text-red-500" />
                )}
            </div>
            {!collapsed && (
                <>
                    <span className="flex-1 text-sm truncate">{channel.name}</span>
                    <button
                        onClick={(e) => { e.stopPropagation(); onRemove(); }}
                        className="opacity-0 group-hover:opacity-100 text-nobuf-subtext hover:text-red-500 transition-all text-xs shrink-0"
                    >
                        ✕
                    </button>
                </>
            )}
        </div>
    );
}
