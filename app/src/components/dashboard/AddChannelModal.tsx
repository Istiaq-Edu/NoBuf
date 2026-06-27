import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
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
            await invoke<PublicChannel>('cmd_add_joined_channel', { channelId: preview.channel_id });
            toast.success('Channel added to NoBuf.');
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
        } catch (e: any) {
            toast.error(String(e));
        } finally {
            setBrowseLoading(false);
        }
    };

    const handleAddFromBrowse = async (channel: JoinedChannel) => {
        try {
            await invoke<PublicChannel>('cmd_add_joined_channel', { channelId: channel.channel_id });
            toast.success(`${channel.name} added to NoBuf.`);
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
        setJoinedChannels([]);
        onClose();
    };

    const filteredJoined = browseSearch
        ? joinedChannels.filter(c => c.name.toLowerCase().includes(browseSearch.toLowerCase()))
        : joinedChannels;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={handleClose}>
            <div
                className="bg-nobuf-bg rounded-2xl border border-nobuf-border w-full max-w-lg max-h-[80vh] flex flex-col"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-4 border-b border-nobuf-border shrink-0">
                    <h3 className="font-semibold text-nobuf-text">Add Public Channel</h3>
                    <button onClick={handleClose} className="text-nobuf-subtext hover:text-nobuf-text transition-colors">
                        ✕
                    </button>
                </div>

                <div className="flex gap-1 p-3 border-b border-nobuf-border shrink-0">
                    <button
                        onClick={() => setTab('link')}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                            tab === 'link'
                                ? 'bg-nobuf-primary text-white'
                                : 'text-nobuf-subtext hover:bg-nobuf-hover'
                        }`}
                    >
                        Paste Link
                    </button>
                    <button
                        onClick={() => { setTab('browse'); if (joinedChannels.length === 0) loadJoinedChannels(); }}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                            tab === 'browse'
                                ? 'bg-nobuf-primary text-white'
                                : 'text-nobuf-subtext hover:bg-nobuf-hover'
                        }`}
                    >
                        Browse Joined
                    </button>
                </div>

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
                                        placeholder="t.me/channelname, t.me/+invite, or @username"
                                        value={linkInput}
                                        onChange={e => setLinkInput(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') handleResolve(); }}
                                    />
                                    <button
                                        onClick={handleResolve}
                                        disabled={resolving || !linkInput.trim()}
                                        className="px-4 py-2.5 rounded-lg bg-nobuf-primary text-white text-sm font-medium hover:bg-nobuf-primary/90 transition-colors disabled:opacity-50"
                                    >
                                        {resolving ? '...' : 'Preview'}
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
                            <input
                                type="text"
                                className="w-full bg-nobuf-hover rounded-lg px-3 py-2.5 text-sm text-nobuf-text placeholder:text-nobuf-subtext focus:outline-none focus:ring-2 focus:ring-nobuf-primary/40 border border-nobuf-border"
                                placeholder="Search joined channels..."
                                value={browseSearch}
                                onChange={e => setBrowseSearch(e.target.value)}
                            />
                            {browseLoading && (
                                <div className="text-center py-8 text-nobuf-subtext text-sm">Loading channels...</div>
                            )}
                            {!browseLoading && filteredJoined.length === 0 && (
                                <div className="text-center py-8 text-nobuf-subtext text-sm">
                                    {joinedChannels.length === 0 ? 'No joined channels found.' : 'No channels match your search.'}
                                </div>
                            )}
                            <div className="space-y-1.5">
                                {filteredJoined.map(channel => (
                                    <div
                                        key={channel.channel_id}
                                        className={`flex items-center gap-3 p-3 rounded-lg border transition-all ${
                                            channel.already_added || channel.is_nb_folder
                                                ? 'border-nobuf-border bg-nobuf-hover/50 opacity-60'
                                                : 'border-nobuf-border hover:bg-nobuf-hover cursor-pointer'
                                        }`}
                                        onClick={() => {
                                            if (!channel.already_added && !channel.is_nb_folder) {
                                                handleAddFromBrowse(channel);
                                            }
                                        }}
                                    >
                                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-nobuf-primary to-blue-500 flex items-center justify-center shrink-0">
                                            <span className="text-white font-bold text-xs">
                                                {channel.name.charAt(0).toUpperCase()}
                                            </span>
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <span className="text-sm font-medium text-nobuf-text block truncate">{channel.name}</span>
                                            {channel.username && (
                                                <span className="text-xs text-nobuf-subtext">@{channel.username}</span>
                                            )}
                                        </div>
                                        {channel.is_nb_folder && (
                                            <span className="text-xs text-nobuf-subtext px-2 py-0.5 rounded bg-nobuf-bg">NoBuf folder</span>
                                        )}
                                        {channel.already_added && !channel.is_nb_folder && (
                                            <span className="text-xs text-nobuf-subtext px-2 py-0.5 rounded bg-nobuf-bg">Added</span>
                                        )}
                                        {!channel.already_added && !channel.is_nb_folder && (
                                            <span className="text-xs text-nobuf-primary font-medium">+ Add</span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
