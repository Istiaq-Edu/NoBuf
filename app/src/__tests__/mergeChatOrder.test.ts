import { describe, expect, it } from 'vitest';
import { mergeChatOrder } from '../hooks/useTelegramConnection';
import { ChatInfo } from '../types';

/** F1/V2-05: the D12 order-merge rule — store owns order, DB owns membership. */
function chat(id: number, title = `c${id}`): ChatInfo {
    return { chat_id: id, peer_kind: 'user', access_hash: 1, title, added_at: 0, group_id: null };
}

describe('mergeChatOrder', () => {
    it('preserves stored order for chats that still exist in the DB', () => {
        const db = [chat(1), chat(2), chat(3)];
        const stored = [chat(3), chat(1), chat(2)];
        expect(mergeChatOrder(db, stored).map(c => c.chat_id)).toEqual([3, 1, 2]);
    });

    it('prunes stored chats missing from the DB', () => {
        const db = [chat(1), chat(3)];
        const stored = [chat(3), chat(2), chat(1)];
        expect(mergeChatOrder(db, stored).map(c => c.chat_id)).toEqual([3, 1]);
    });

    it('appends new DB rows at the end', () => {
        const db = [chat(1), chat(2), chat(9)];
        const stored = [chat(2), chat(1)];
        expect(mergeChatOrder(db, stored).map(c => c.chat_id)).toEqual([2, 1, 9]);
    });

    it('uses fresh DB data (title/hash refresh) while keeping position', () => {
        const db = [chat(1, 'New Name')];
        const stored = [chat(1, 'Old Name')];
        const merged = mergeChatOrder(db, stored);
        expect(merged[0].title).toBe('New Name');
    });

    it('handles an empty store (first run) and an empty DB', () => {
        expect(mergeChatOrder([chat(1), chat(2)], []).map(c => c.chat_id)).toEqual([1, 2]);
        expect(mergeChatOrder([], [chat(1)])).toEqual([]);
    });

    it('dedupes duplicate stored entries', () => {
        const db = [chat(1), chat(2)];
        const stored = [chat(2), chat(2), chat(1)];
        expect(mergeChatOrder(db, stored).map(c => c.chat_id)).toEqual([2, 1]);
    });
});
