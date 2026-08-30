import { describe, expect, it } from 'vitest';
import { filterHidden } from '../context/VaultContext';
import { ChatInfo } from '../types';

/**
 * F5: vault chat-kind state mapping. The pure filter is the load-bearing
 * piece the sidebar consumes (visibleChats) — the full context shape is
 * exercised via the Rust-side state_response tests (chat_count/chat_ids).
 */
function chat(id: number): ChatInfo {
    return { chat_id: id, peer_kind: 'user', access_hash: 1, title: `c${id}`, added_at: 0, group_id: null };
}

describe('vault chat filtering (visibleChats)', () => {
    it('drops chats whose ids are in hiddenChatIds', () => {
        const chats = [chat(1), chat(2), chat(3)];
        const hidden = new Set([2]);
        expect(filterHidden(chats, c => c.chat_id, hidden).map(c => c.chat_id)).toEqual([1, 3]);
    });

    it('returns the full list when nothing is hidden', () => {
        const chats = [chat(1), chat(2)];
        expect(filterHidden(chats, c => c.chat_id, new Set())).toEqual(chats);
    });

    it('does not mutate the input array (persistence writers rely on raw arrays)', () => {
        const chats = [chat(1), chat(2)];
        const snapshot = [...chats];
        filterHidden(chats, c => c.chat_id, new Set([1]));
        expect(chats).toEqual(snapshot);
    });
});
