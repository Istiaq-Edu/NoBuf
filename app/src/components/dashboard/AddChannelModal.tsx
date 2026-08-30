import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Link as LinkIcon, Compass, Loader2, Search, X, Check, Radio } from 'lucide-react';
import { ChannelPreview, JoinedChannel, PublicChannel } from '../../types';
import { ChannelPreviewCard } from './ChannelPreviewCard';

interface Props {
    open: boolean;
    onClose: () => void;
    onAdded: () => void;
}

export function AddChannelModal({ open, onClose, onAdded }: Props) {
    const [tab, setTab] = useState<'link' | 'browse'>('link');
    const [linkInput, setLinkInput] = useState('');
    const [preview, setPreview] = useState<ChannelPreview | null>(null);
    const [resolving, setResolving] = useState(false);
    const [joining, setJoining] = useState(false);
    const [joinedChannels, setJoinedChannels] = useState<JoinedChannel[]>([]);
    const [browseSearch, setBrowseSearch] = useState('');
    const [browseLoading, setBrowseLoading] = useState(false);
    const [browseFetched, setBrowseFetched] = useState(false);

    // Push the local channel list to the [NB-PUB] sync channel after any add.
    // Fire-and-forget: the local SQLite row is already committed, so a failed
    // upload only means the change stays local until the next successful one.
    const uploadSync = () => {
        invoke('cmd_update_nb_pub_sync').catch((e: any) => {
            console.warn('[Public Channels] Sync update failed:', e);
            toast.error('Sync update failed — changes are local only.');
        });
    };

    // Fetch joined channels once when modal opens (not on every tab switch)
    useEffect(() => {
        if (!open || browseFetched) return;
        loadJoinedChannels();
    }, [open]);

    if (!open) return null;

    const handleResolve = async () => {
        if (!linkInput.trim()) return;
        setResolving(true);
        setPreview(null);
        try {
            const result = await invoke<ChannelPreview>('cmd_resolve_channel_link', { link: linkInput });
            setPreview(result);
        } catch (e: any) {
            toast.error(String(e));
        } finally {
            setResolving(false);
        }
    };

    const handleJoin = async () => {
        if (!linkInput.trim()) return;
        setJoining(true);
        try {
            await invoke<PublicChannel>('cmd_join_channel_by_link', { link: linkInput });
            toast.success('Channel added to NoBuf.');
            uploadSync();
            onAdded();
            handleClose();
        } catch (e: any) {
            const err = String(e);
            if (err.startsWith('ALREADY_ADDED')) {
                toast.info('This channel is already added to NoBuf.');
            } else {
                toast.error(err);
            }
        } finally {
            setJoining(false);
        }
    };

    const handleAddExisting = async () => {
        if (!preview?.channel_id) return;
        setJoining(true);
        try {
            await invoke<PublicChannel>('cmd_add_joined_channel', { channelId: preview.channel_id, accessHash: preview.access_hash });
            toast.success('Channel added to NoBuf.');
            uploadSync();
            onAdded();
            handleClose();
        } catch (e: any) {
            const err = String(e);
            if (err.startsWith('ALREADY_ADDED')) {
                toast.info('This channel is already added to NoBuf.');
            } else {
                toast.error(err);
            }
        } finally {
            setJoining(false);
        }
    };

    const loadJoinedChannels = async () => {
        setBrowseLoading(true);
        try {
            const channels = await invoke<JoinedChannel[]>('cmd_list_joined_channels');
            setJoinedChannels(channels);
            setBrowseFetched(true);
        } catch (e: any) {
            toast.error(String(e));
        } finally {
            setBrowseLoading(false);
        }
    };

    const handleAddFromBrowse = async (channel: JoinedChannel) => {
        try {
            await invoke<PublicChannel>('cmd_add_joined_channel', { channelId: channel.channel_id, accessHash: channel.access_hash });
            toast.success(`${channel.name} added to NoBuf.`);
            uploadSync();
            onAdded();
            setJoinedChannels(prev => prev.map(c =>
                c.channel_id === channel.channel_id ? { ...c, already_added: true } : c
            ));
        } catch (e: any) {
            const err = String(e);
            if (err.startsWith('ALREADY_ADDED')) {
                toast.info('Already added.');
            } else {
                toast.error(err);
            }
        }
    };

    const handleClose = () => {
        setLinkInput('');
        setPreview(null);
        setBrowseSearch('');
        onClose();
    };

    const filteredJoined = browseSearch
        ? joinedChannels.filter(c => c.name.toLowerCase().includes(browseSearch.toLowerCase()))
        : joinedChannels;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={handleClose}>
            <div
                className="bg-nobuf-bg rounded-2xl border border-nobuf-border w-full max-w-lg max-h-[80vh] flex flex-col shadow-2xl"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-nobuf-border shrink-0">
                    <h3 className="font-semibold text-nobuf-text">Add Public Channel</h3>
                    <button onClick={handleClose} className="text-nobuf-subtext hover:text-nobuf-text transition-colors p-1 rounded hover:bg-nobuf-hover">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Segmented tab control */}
                <div className="flex gap-1 p-3 border-b border-nobuf-border shrink-0">
                    <button
                        onClick={() => setTab('link')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                            tab === 'link'
                                ? 'bg-nobuf-primary text-white'
                                : 'text-nobuf-subtext hover:bg-nobuf-hover'
                        }`}
                    >
                        <LinkIcon className="w-4 h-4" />
                        Paste Link
                    </button>
                    <button
                        onClick={() => setTab('browse')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                            tab === 'browse'
                                ? 'bg-nobuf-primary text-white'
                                : 'text-nobuf-subtext hover:bg-nobuf-hover'
                        }`}
                    >
                        <Compass className="w-4 h-4" />
                        Browse Joined
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-4 sidebar-scroll">
                    {tab === 'link' && (
                        <div className="space-y-4">
                            <div>
                                <label className="text-xs text-nobuf-subtext mb-1.5 block">Telegram channel link or @username</label>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        autoFocus
                                        className="flex-1 bg-nobuf-hover rounded-lg px-3 py-2.5 text-sm text-nobuf-text placeholder:text-nobuf-subtext focus:outline-none focus:ring-2 focus:ring-nobuf-primary/40 border border-nobuf-border"
                                        placeholder="t.me/channelname or @channel"
                                        value={linkInput}
                                        onChange={e => setLinkInput(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') handleResolve(); }}
                                    />
                                    <button
                                        onClick={handleResolve}
                                        disabled={resolving || !linkInput.trim()}
                                        className="px-4 py-2.5 rounded-lg bg-nobuf-primary text-white text-sm font-medium hover:brightness-110 active:scale-95 transition-all disabled:opacity-50 flex items-center gap-2"
                                    >
                                        {resolving ? (
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                        ) : (
                                            <Search className="w-4 h-4" />
                                        )}
                                        <span className="hidden sm:inline">Preview</span>
                                    </button>
                                </div>
                                <p className="text-xs text-nobuf-subtext mt-1.5">
                                    Paste a public channel link (t.me/name) or private invite (t.me/+abc).
                                </p>
                            </div>
                            {preview && (
                                <ChannelPreviewCard
                                    preview={preview}
                                    onJoin={handleJoin}
                                    onAddExisting={handleAddExisting}
                                    loading={joining}
                                />
                            )}
                        </div>
                    )}

                    {tab === 'browse' && (
                        <div className="space-y-3">
                            {/* Search input with icon */}
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-nobuf-subtext pointer-events-none" />
                                <input
                                    type="text"
                                    className="w-full bg-nobuf-hover rounded-lg pl-9 pr-3 py-2.5 text-sm text-nobuf-text placeholder:text-nobuf-subtext focus:outline-none focus:ring-2 focus:ring-nobuf-primary/40 border border-nobuf-border"
                                    placeholder="Search joined channels..."
                                    value={browseSearch}
                                    onChange={e => setBrowseSearch(e.target.value)}
                                />
                            </div>

                            {/* Loading state */}
                            {browseLoading && (
                                <div className="flex flex-col items-center justify-center py-12 gap-2">
                                    <Loader2 className="w-6 h-6 animate-spin text-nobuf-primary" />
                                    <span className="text-sm text-nobuf-subtext">Loading channels...</span>
                                </div>
                            )}

                            {/* Empty states */}
                            {!browseLoading && filteredJoined.length === 0 && (
                                <div className="flex flex-col items-center justify-center py-12 gap-2">
                                    <Compass className="w-8 h-8 text-nobuf-subtext/40" />
                                    <span className="text-sm text-nobuf-subtext">
                                        {joinedChannels.length === 0 ? 'No joined channels found.' : 'No channels match your search.'}
                                    </span>
                                </div>
                            )}

                            {/* Channel list */}
                            {!browseLoading && filteredJoined.length > 0 && (
                                <div className="space-y-1">
                                    {filteredJoined.map(channel => {
                                        const disabled = channel.already_added || channel.is_nb_folder;
                                        return (
                                            <div
                                                key={channel.channel_id}
                                                className={`flex items-center gap-3 p-2.5 rounded-lg border transition-all ${
                                                    disabled
                                                        ? 'border-nobuf-border bg-nobuf-hover/30 opacity-50'
                                                        : 'border-nobuf-border hover:bg-nobuf-hover hover:border-nobuf-primary/30 cursor-pointer'
                                                }`}
                                                onClick={() => {
                                                    if (!disabled) handleAddFromBrowse(channel);
                                                }}
                                            >
                                                {/* Avatar */}
                                                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-nobuf-primary to-blue-500 flex items-center justify-center shrink-0">
                                                    <span className="text-white font-bold text-xs">
                                                        {channel.name.charAt(0).toUpperCase()}
                                                    </span>
                                                </div>
                                                {/* Name + username */}
                                                <div className="flex-1 min-w-0">
                                                    <span className="text-sm font-medium text-nobuf-text block truncate">{channel.name}</span>
                                                    {channel.username && (
                                                        <span className="text-xs text-nobuf-subtext">@{channel.username}</span>
                                                    )}
                                                </div>
                                                {/* Status badge */}
                                                {channel.is_nb_folder && (
                                                    <span className="flex items-center gap-1 text-xs text-nobuf-subtext px-2 py-1 rounded bg-nobuf-bg shrink-0">
                                                        <Radio className="w-3 h-3" />
                                                        NoBuf
                                                    </span>
                                                )}
                                                {channel.already_added && !channel.is_nb_folder && (
                                                    <span className="flex items-center gap-1 text-xs text-green-400 px-2 py-1 rounded bg-green-400/10 shrink-0">
                                                        <Check className="w-3 h-3" />
                                                        Added
                                                    </span>
                                                )}
                                                {!channel.already_added && !channel.is_nb_folder && (
                                                    <span className="text-xs text-nobuf-primary font-medium px-2 py-1 rounded bg-nobuf-primary/10 shrink-0">
                                                        + Add
                                                    </span>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}