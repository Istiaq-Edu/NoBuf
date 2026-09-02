import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';

/**
 * Chats-section hooks (normal_chats backend, plan F1).
 *
 * useChatFiles — a chat's media grid with offset pagination, cloned from
 *   usePublicChannelFiles. CHAT_GONE errors surface as a `chatGone` flag —
 *   hooks can't navigate (no router; activeView is Dashboard-local state),
 *   so the Dashboard's effect performs the auto-remove + toast + navigate
 *   (plan §2.2, review2 V2-19 — the notAMember pattern).
 *
 * The sidebar's chats LIST lives in useTelegramConnection state (store+DB
 * merge via mergeChatOrder) — not react-query (F-A11: the unused ['chats']
 * query hook was dead code and was removed).
 */

export function useChatFiles(chatId: number | null) {
    const queryClient = useQueryClient();

    const { data, isLoading } = useQuery({
            queryKey: ['chatFiles', chatId, 0],
            queryFn: async () => {
                if (!chatId) return { files: [], hasMore: false, lastOffsetId: null, chatGone: false };
                try {
                    const [files, hasMore] = await invoke<[any[], boolean]>('cmd_get_chat_files', {
                        chatId,
                        offsetId: null,
                    });
                    return {
                        files: files.map((f: any) => ({ ...f, sizeStr: formatBytesLocal(f.size), type: f.icon_type || 'file' })),
                        hasMore,
                        lastOffsetId: files.length > 0 ? files[files.length - 1].id : null,
                        chatGone: false,
                    };
                } catch (e: any) {
                    if (String(e).includes('CHAT_GONE')) {
                        return { files: [], hasMore: false, lastOffsetId: null, chatGone: true };
                    }
                    throw e;
                }
            },
            enabled: chatId !== null,
            staleTime: 60_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
        });

    const loadMore = useMutation({
            mutationFn: async (offsetId: number) => {
                try {
                    const [files, hasMore] = await invoke<[any[], boolean]>('cmd_get_chat_files', {
                        chatId: chatId!,
                        offsetId,
                    });
                    return {
                        files: files.map((f: any) => ({ ...f, sizeStr: formatBytesLocal(f.size), type: f.icon_type || 'file' })),
                        hasMore,
                        lastOffsetId: files.length > 0 ? files[files.length - 1].id : null,
                        chatGone: false,
                    };
                } catch (e: any) {
                    if (String(e).includes('CHAT_GONE')) {
                        return { files: [], hasMore: false, lastOffsetId: null, chatGone: true };
                    }
                    throw e;
                }
            },
            onSuccess: (newData) => {
                queryClient.setQueryData(['chatFiles', chatId, 0], (prev: any) => ({
                    files: [...(prev?.files || []), ...newData.files],
                    hasMore: newData.hasMore,
                    lastOffsetId: newData.lastOffsetId,
                    chatGone: newData.chatGone || prev?.chatGone || false,
                }));
            },
        });

    return {
        files: data?.files || [],
        isLoading,
        hasMore: data?.hasMore || false,
        lastOffsetId: data?.lastOffsetId || null,
        chatGone: data?.chatGone || false,
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
