import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Link as LinkIcon, Compass, Loader2, Search, X, Check, Radio, Crown, Shield } from 'lucide-react';
import { ChannelPreview, JoinedChannel, PublicChannel, TelegramFolder } from '../../types';
import { ChannelPreviewCard } from './ChannelPreviewCard';

interface Props {
    open: boolean;
    onClose: () => void;
    onAdded: () => void;
    /** Adopt an owned/administered channel as a full folder (not read-only). */
    onAdoptChannel?: (channelId: number, accessHash: number) => Promise<TelegramFolder | null>;
    /**
     * What the modal is for — set by the entry point:
     * - 'private'  (Private Channels '+'): ONLY owned/administered channels
     *   adoptable as folders. No public-channel flows shown.
     * - 'public'   (Public Channels '+'): ONLY public-channel flows —
     *   paste link + joined-channels list. No adoption section.
     */
    mode?: 'private' | 'public';
}

export function AddChannelModal({ open, onClose, onAdded, onAdoptChannel, mode = 'public' }: Props) {
    const [tab, setTab] = useState<'link' | 'browse'>('link');
    const [linkInput, setLinkInput] = useState('');
    const [preview, setPreview] = useState<ChannelPreview | null>(null);
    const [resolving, setResolving] = useState(false);
    const [joining, setJoining] = useState(false);
    const [joinedChannels, setJoinedChannels] = useState<JoinedChannel[]>([]);
    const [browseSearch, setBrowseSearch] = useState('');
    const [browseLoading, setBrowseLoading] = useState(false);
    const [browseFetched, setBrowseFetched] = useState(false);
    const [ownedChannels, setOwnedChannels] = useState<JoinedChannel[]>([]);
    const [ownedLoading, setOwnedLoading] = useState(false);
    const [ownedScanFailed, setOwnedScanFailed] = useState(false);
    const [adoptingId, setAdoptingId] = useState<number | null>(null);

    // Private mode has no tabs — it's a single owned-channels list.
    const effectiveTab = mode === 'private' ? 'browse' : tab;

    // Reopen always lands on the intended tab (state persists while mounted).
    useEffect(() => {
        if (open && mode === 'public') setTab('link');
    }, [open, mode]);

    // Push the local channel list to the [NB-PUB] sync channel after any add.
    // Fire-and-forget: the local SQLite row is already committed, so a failed
    // upload only means the change stays local until the next successful one.
    const uploadSync = () => {
        invoke('cmd_update_nb_pub_sync').catch((e: any) => {
            console.warn('[Public Channels] Sync update failed:', e);
            toast.error('Sync update failed — changes are local only.');
        });
    };

    // Fetch channels once when modal opens (not on every tab switch).
    // Mode-scoped: private mode only scans owned channels; public mode only
    // lists joined channels — no cross-fetching either way.
    useEffect(() => {
        if (!open || browseFetched) return;
        if (mode === 'private') {
            loadOwnedChannels();
            setBrowseFetched(true);
        } else {
            loadJoinedChannels();
        }
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

    const loadOwnedChannels = async () => {
        setOwnedLoading(true);
        try {
            const channels = await invoke<JoinedChannel[]>('cmd_list_owned_channels');
            setOwnedChannels(channels);
            setOwnedScanFailed(false);
        } catch (e: any) {
            // F20: a silent catch made the whole section vanish — surface it.
            console.warn('[Adopt] owned-channel scan failed:', e);
            setOwnedScanFailed(true);
        } finally {
            setOwnedLoading(false);
        }
    };

    // Adopt: channel becomes a full read-write folder (original title kept,
    // no [NB] tag). The handler in useTelegramConnection pushes the returned
    // folder into folders state directly, so it appears immediately.
    const handleAdopt = async (channel: JoinedChannel) => {
        if (!onAdoptChannel) return;
        setAdoptingId(channel.channel_id);
        try {
            const folder = await onAdoptChannel(channel.channel_id, channel.access_hash);
            if (folder) {
                uploadSync();
                onAdded();
                setOwnedChannels(prev => prev.filter(c => c.channel_id !== channel.channel_id));
            }
        } finally {
            setAdoptingId(null);
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
        // Reset the fetch latch so eligibility/already-added state is fresh on
        // the next open (pre-existing staleness: the latch never cleared).
        setBrowseFetched(false);
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
                    <h3 className="font-semibold text-nobuf-text">
                        {mode === 'private' ? 'Add Private Channel' : 'Add Public Channel'}
                    </h3>
                    <button onClick={handleClose} className="text-nobuf-subtext hover:text-nobuf-text transition-colors p-1 rounded hover:bg-nobuf-hover">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Segmented tab control — public mode only */}
                {mode === 'public' && (
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
                )}

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-4 sidebar-scroll">
                    {mode === 'public' && tab === 'link' && (
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

                    {effectiveTab === 'browse' && (
                        <div className="space-y-3">
                            {/* Search input with icon */}
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-nobuf-subtext pointer-events-none" />
                                <input
                                    type="text"
                                    className="w-full bg-nobuf-hover rounded-lg pl-9 pr-3 py-2.5 text-sm text-nobuf-text placeholder:text-nobuf-subtext focus:outline-none focus:ring-2 focus:ring-nobuf-primary/40 border border-nobuf-border"
                                    placeholder={mode === 'private' ? 'Search your channels...' : 'Search joined channels...'}
                                    value={browseSearch}
                                    onChange={e => setBrowseSearch(e.target.value)}
                                />
                            </div>

                            {/* Loading state — joined list (public mode only) */}
                            {mode === 'public' && browseLoading && (
                                <div className="flex flex-col items-center justify-center py-12 gap-2">
                                    <Loader2 className="w-6 h-6 animate-spin text-nobuf-primary" />
                                    <span className="text-sm text-nobuf-subtext">Loading channels...</span>
                                </div>
                            )}

                            {/* Empty states — joined list (public mode only) */}
                            {mode === 'public' && !browseLoading && filteredJoined.length === 0 && (
                                <div className="flex flex-col items-center justify-center py-12 gap-2">
                                    <Compass className="w-8 h-8 text-nobuf-subtext/40" />
                                    <span className="text-sm text-nobuf-subtext">
                                        {joinedChannels.length === 0 ? 'No joined channels found.' : 'No channels match your search.'}
                                    </span>
                                </div>
                            )}

                            {/* Channel list — joined channels (public mode only) */}
                            {mode === 'public' && !browseLoading && filteredJoined.length > 0 && (
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

                            {/* ─── Your channels (adopt as folders) ─────────── */}
                            {onAdoptChannel && (mode === 'private' || effectiveTab === 'browse') && (ownedLoading || ownedChannels.length > 0 || ownedScanFailed) && (
                                <div className="pt-3">
                                    <div className="flex items-center gap-1.5 text-xs font-semibold text-nobuf-subtext uppercase tracking-wider pb-2">
                                        <Crown className="w-3.5 h-3.5" />
                                        {mode === 'private' ? 'Your Channels — tap to add as a folder' : 'Your Channels — add as folders'}
                                    </div>
                                    {ownedLoading && (
                                        <div className="flex items-center justify-center py-6 gap-2">
                                            <Loader2 className="w-5 h-5 animate-spin text-nobuf-primary" />
                                            <span className="text-sm text-nobuf-subtext">Scanning your channels…</span>
                                        </div>
                                    )}
                                    {ownedScanFailed && !ownedLoading && (
                                        <div className="px-3 py-2 text-xs text-nobuf-subtext italic">
                                            Couldn't scan your channels. Try reopening this dialog.
                                        </div>
                                    )}
                                    {!ownedLoading && ownedChannels.length > 0 && (
                                        <div className="space-y-1">
                                            {ownedChannels
                                                .filter(c => !browseSearch || c.name.toLowerCase().includes(browseSearch.toLowerCase()))
                                                .map(channel => (
                                                    <div
                                                        key={channel.channel_id}
                                                        className="flex items-center gap-3 p-2.5 rounded-lg border border-nobuf-border hover:bg-nobuf-hover hover:border-nobuf-primary/30 cursor-pointer transition-all"
                                                        onClick={() => { if (adoptingId === null) handleAdopt(channel); }}
                                                    >
                                                        {/* Avatar */}
                                                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center shrink-0">
                                                            <span className="text-white font-bold text-xs">
                                                                {channel.name.charAt(0).toUpperCase()}
                                                            </span>
                                                        </div>
                                                        {/* Name + ownership badge */}
                                                        <div className="flex-1 min-w-0">
                                                            <span className="text-sm font-medium text-nobuf-text block truncate">{channel.name}</span>
                                                            <span className="flex items-center gap-1 text-xs text-nobuf-subtext">
                                                                {channel.is_creator
                                                                    ? <><Crown className="w-3 h-3 text-amber-400" /> Owner</>
                                                                    : <><Shield className="w-3 h-3 text-blue-400" /> Admin</>
                                                                }
                                                                {channel.username && <span className="ml-1">@{channel.username}</span>}
                                                            </span>
                                                        </div>
                                                        {/* Action */}
                                                        {adoptingId === channel.channel_id ? (
                                                            <Loader2 className="w-4 h-4 animate-spin text-nobuf-primary shrink-0" />
                                                        ) : (
                                                            <span className="text-xs text-amber-400 font-medium px-2 py-1 rounded bg-amber-400/10 shrink-0">
                                                                + Folder
                                                            </span>
                                                        )}
                                                    </div>
                                                ))}
                                        </div>
                                    )}
                                    {mode === 'private' && !ownedLoading && !ownedScanFailed && ownedChannels.length === 0 && (
                                        <div className="px-3 py-6 text-center text-sm text-nobuf-subtext">
                                            No channels you own or administer (with post permission) were found.
                                        </div>
                                    )}
                                    <p className="text-[11px] text-nobuf-subtext/70 px-1 pt-2">
                                        Channels you own or administer become full NoBuf folders — upload, download, move — keeping their original name (no [NB] tag).
                                    </p>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}