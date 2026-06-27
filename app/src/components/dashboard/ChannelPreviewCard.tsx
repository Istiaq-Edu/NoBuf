import { ChannelPreview } from '../../types';

interface Props {
    preview: ChannelPreview;
    onJoin: () => void;
    onAddExisting: () => void;
    loading: boolean;
}

export function ChannelPreviewCard({ preview, onJoin, onAddExisting, loading }: Props) {
    return (
        <div className="bg-nobuf-hover rounded-xl border border-nobuf-border p-4 space-y-3">
            <div className="flex items-start gap-3">
                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-nobuf-primary to-blue-500 flex items-center justify-center shrink-0">
                    <span className="text-white font-bold text-lg">
                        {preview.title.charAt(0).toUpperCase()}
                    </span>
                </div>
                <div className="flex-1 min-w-0">
                    <h4 className="font-semibold text-nobuf-text truncate">{preview.title}</h4>
                    {preview.about && (
                        <p className="text-sm text-nobuf-subtext line-clamp-2 mt-1">{preview.about}</p>
                    )}
                    <div className="flex items-center gap-3 mt-2 text-xs text-nobuf-subtext">
                        {preview.participants_count > 0 && (
                            <span>{preview.participants_count.toLocaleString()} subscribers</span>
                        )}
                        {preview.is_private && (
                            <span className="flex items-center gap-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                                Private
                            </span>
                        )}
                        {preview.is_channel && (
                            <span className="flex items-center gap-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                                Channel
                            </span>
                        )}
                    </div>
                </div>
            </div>
            <button
                onClick={preview.already_joined ? onAddExisting : onJoin}
                disabled={loading}
                className="w-full py-2.5 rounded-lg bg-nobuf-primary text-white font-medium text-sm hover:bg-nobuf-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
                {loading ? 'Joining...' : preview.already_joined ? 'Add to NoBuf' : 'Join & Add'}
            </button>
        </div>
    );
}
