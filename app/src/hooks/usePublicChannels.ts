import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { PublicChannel, ChannelPreview } from '../types';

export function usePublicChannels() {
    const queryClient = useQueryClient();

    const { data: publicChannels = [], isLoading } = useQuery<PublicChannel[]>({
        queryKey: ['publicChannels'],
        queryFn: () => invoke<PublicChannel[]>('cmd_get_public_channels'),
    });

    const resolveLink = useMutation({
        mutationFn: (link: string) => invoke<ChannelPreview>('cmd_resolve_channel_link', { link }),
        onError: (e: string) => toast.error(e),
    });

    const joinByLink = useMutation({
        mutationFn: (link: string) => invoke<PublicChannel>('cmd_join_channel_by_link', { link }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['publicChannels'] });
            invoke('cmd_update_nb_pub_sync').catch(() => {});
        },
        onError: (e: string) => {
            if (e.startsWith('ALREADY_ADDED')) {
                toast.info('This channel is already added to NoBuf.');
            } else {
                toast.error(e);
            }
        },
    });

    const addJoined = useMutation({
        mutationFn: (channelId: number) => invoke<PublicChannel>('cmd_add_joined_channel', { channelId }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['publicChannels'] });
            invoke('cmd_update_nb_pub_sync').catch(() => {});
        },
        onError: (e: string) => {
            if (e.startsWith('ALREADY_ADDED')) {
                toast.info('This channel is already added to NoBuf.');
            } else {
                toast.error(e);
            }
        },
    });

    const removeChannel = useMutation({
        mutationFn: ({ channelId, leaveOnTelegram }: { channelId: number; leaveOnTelegram: boolean }) =>
            invoke<boolean>('cmd_remove_public_channel', { channelId, leaveOnTelegram }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['publicChannels'] });
            invoke('cmd_update_nb_pub_sync').catch(() => {});
        },
        onError: (e: string) => toast.error(e),
    });

    const syncFromRemote = useMutation({
        mutationFn: () => invoke<PublicChannel[]>('cmd_sync_public_channels'),
        onSuccess: (data) => {
            queryClient.setQueryData(['publicChannels'], data);
        },
    });

    return {
        publicChannels,
        isLoading,
        resolveLink,
        joinByLink,
        addJoined,
        removeChannel,
        syncFromRemote,
    };
}

export function usePublicChannelFiles(channelId: number | null) {
    const queryClient = useQueryClient();

    const { data, isLoading, error } = useQuery({
        queryKey: ['publicChannelFiles', channelId, 0],
        queryFn: async () => {
            if (!channelId) return { files: [], hasMore: false, lastOffsetId: null, notAMember: false };
            try {
                const [files, hasMore] = await invoke<[any[], boolean]>('cmd_get_public_channel_files', {
                    channelId,
                    offsetId: null,
                });
                return {
                    files: files.map((f: any) => ({ ...f, sizeStr: formatBytesLocal(f.size) })),
                    hasMore,
                    lastOffsetId: files.length > 0 ? files[files.length - 1].id : null,
                    notAMember: false,
                };
            } catch (e: any) {
                if (String(e).includes('NOT_A_MEMBER')) {
                    return { files: [], hasMore: false, lastOffsetId: null, notAMember: true };
                }
                throw e;
            }
        },
        enabled: channelId !== null,
    });

    const loadMore = useMutation({
        mutationFn: async (offsetId: number) => {
            const [files, hasMore] = await invoke<[any[], boolean]>('cmd_get_public_channel_files', {
                channelId: channelId!,
                offsetId,
            });
            return {
                files: files.map((f: any) => ({ ...f, sizeStr: formatBytesLocal(f.size) })),
                hasMore,
                lastOffsetId: files.length > 0 ? files[files.length - 1].id : null,
            };
        },
        onSuccess: (newData) => {
            queryClient.setQueryData(['publicChannelFiles', channelId, 0], (prev: any) => ({
                files: [...(prev?.files || []), ...newData.files],
                hasMore: newData.hasMore,
                lastOffsetId: newData.lastOffsetId,
                notAMember: false,
            }));
        },
    });

    return {
        files: data?.files || [],
        hasMore: data?.hasMore || false,
        lastOffsetId: data?.lastOffsetId || null,
        notAMember: data?.notAMember || false,
        isLoading,
        error,
        loadMore,
    };
}

function formatBytesLocal(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
