import { Loader2, Lock, Users, Radio } from 'lucide-react';
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
                {/* Avatar with gradient */}
                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-nobuf-primary to-blue-500 flex items-center justify-center shrink-0 ring-2 ring-nobuf-border">
                    <span className="text-white font-bold text-lg">
                        {preview.title.charAt(0).toUpperCase()}
                    </span>
                </div>
                <div className="flex-1 min-w-0">
                    <h4 className="font-semibold text-nobuf-text truncate">{preview.title}</h4>
                    {preview.about && (
                        <p className="text-sm text-nobuf-subtext line-clamp-2 mt-0.5">{preview.about}</p>
                    )}
                    {/* Badges row */}
                    <div className="flex items-center gap-3 mt-2 text-xs text-nobuf-subtext">
                        {preview.participants_count > 0 && (
                            <span className="flex items-center gap-1">
                                <Users className="w-3 h-3" />
                                {preview.participants_count.toLocaleString()}
                            </span>
                        )}
                        {preview.is_private && (
                            <span className="flex items-center gap-1 text-amber-400">
                                <Lock className="w-3 h-3" />
                                Private
                            </span>
                        )}
                        {preview.is_channel && (
                            <span className="flex items-center gap-1 text-green-400">
                                <Radio className="w-3 h-3" />
                                Channel
                            </span>
                        )}
                    </div>
                </div>
            </div>
            {/* Action button */}
            <button
                onClick={preview.already_joined ? onAddExisting : onJoin}
                disabled={loading}
                className="w-full py-2.5 rounded-lg bg-nobuf-primary text-white font-medium text-sm hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
                {loading ? (
                    <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        {preview.already_joined ? 'Adding...' : 'Joining...'}
                    </>
                ) : (
                    preview.already_joined ? 'Add to NoBuf' : 'Join & Add'
                )}
            </button>
        </div>
    );
}