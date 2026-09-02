import { describe, expect, it } from 'vitest';
import { reorderChatList } from '../components/dashboard/ChatSidebarSection';
import { ChatInfo } from '../types';

/** F-A01 pin: reorder math runs on the FULL list — a filtered render list
 *  must never replace the persisted chats array. */
function chat(id: number): ChatInfo {
    return { chat_id: id, peer_kind: 'user', access_hash: 1, title: `c${id}`, added_at: 0, group_id: null };
}

describe('reorderChatList (F-A01: list conservation)', () => {
    it('reorders within the FULL list while a filter hides members', () => {
        const all = [chat(1), chat(2), chat(3), chat(4)];
        // Render list under a group chip = [1, 3]; user drags 3 above 1.
        const result = reorderChatList(all, 3, 1, 'above');
        expect(result).not.toBeNull();
        expect(result!.map(c => c.chat_id)).toEqual([3, 1, 2, 4]);
        // Conservation: no chat lost, no chat duplicated.
        expect(result!.length).toBe(4);
        expect(new Set(result!.map(c => c.chat_id)).size).toBe(4);
    });

    it('moves a chat to the end (below the last item)', () => {
        const all = [chat(1), chat(2), chat(3)];
        const result = reorderChatList(all, 1, 3, 'below');
        expect(result!.map(c => c.chat_id)).toEqual([2, 3, 1]);
    });

    it('drop-on-self returns null (no-op)', () => {
        const all = [chat(1), chat(2)];
        expect(reorderChatList(all, 1, 1, 'below')).toBeNull();
    });

    it('unknown dragged or target id returns null (no corruption)', () => {
        const all = [chat(1), chat(2)];
        expect(reorderChatList(all, 99, 1, 'above')).toBeNull();
        expect(reorderChatList(all, 1, 99, 'below')).toBeNull();
    });

    it('does not mutate the input list', () => {
        const all = [chat(1), chat(2), chat(3)];
        const snapshot = all.map(c => c.chat_id);
        reorderChatList(all, 1, 3, 'below');
        expect(all.map(c => c.chat_id)).toEqual(snapshot);
    });
});
