// @vitest-environment jsdom
/**
 * Sidebar context-menu close-on-outside-mousedown regression tests.
 *
 * Bug (reported 2026-09-02): right-clicking a chat / public-channel row opened a
 * context menu, but right-clicking ANOTHER row opened a second menu without closing
 * the first — menus stacked. Root cause: ChatItem.tsx and PublicChannelItem.tsx
 * closed their menus via a row-local `onMouseDown={showMenu ? closeOnOutside : undefined}`,
 * which only fires when the next click lands back on THAT row. SidebarItem (folders /
 * private channels) already used a document-level `mousedown` listener — the pattern
 * these tests pin for both fixed components.
 *
 * A real right-click fires mousedown BEFORE contextmenu; RTL's fireEvent.contextMenu
 * dispatches only the contextmenu event, so tests pair it with an explicit mouseDown
 * on the same row to reproduce the real event order.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, fireEvent, screen } from '@testing-library/react';
import { ChatItem } from '../components/dashboard/ChatItem';
import { PublicChannelItem } from '../components/dashboard/PublicChannelItem';
import { ChatInfo, PublicChannel } from '../types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve([])) }));

const chatA: ChatInfo = { chat_id: 1, peer_kind: 'user', access_hash: 100, title: 'Alice', added_at: 0, group_id: null };
const chatB: ChatInfo = { chat_id: 2, peer_kind: 'basic_group', access_hash: null, title: 'Bob Group', added_at: 0, group_id: null };

const pubA: PublicChannel = { channel_id: 1, name: 'Chan A', username: 'chana', access_hash: 100, is_private: false, added_at: 0, is_member: true };
const pubB: PublicChannel = { channel_id: 2, name: 'Chan B', username: null, access_hash: 200, is_private: false, added_at: 0, is_member: true };

const menuCount = () => screen.queryAllByText('Hide in Vault').length;

/** Real right-click = mousedown (button 2) then contextmenu, on the same element. */
const rightClick = (el: Element, x = 50, y = 50) => {
    fireEvent.mouseDown(el, { button: 2, clientX: x, clientY: y });
    fireEvent.contextMenu(el, { button: 2, clientX: x, clientY: y });
};

afterEach(cleanup);

describe('ChatItem context menu close-on-outside', () => {
    it('closes the open menu when another row is right-clicked (no stacked menus)', () => {
        const { container } = render(
            <div>
                <ChatItem chat={chatA} active={false} collapsed={false} onClick={() => {}} onRemove={() => {}} onHideInVault={() => {}} />
                <ChatItem chat={chatB} active={false} collapsed={false} onClick={() => {}} onRemove={() => {}} onHideInVault={() => {}} />
            </div>
        );
        const rows = container.querySelectorAll('.cursor-pointer');
        expect(rows.length).toBe(2);

        // Right-click row A → menu opens.
        rightClick(rows[0], 50, 50);
        expect(menuCount()).toBe(1);

        // Right-click row B → row A's menu must close (mousedown lands outside it),
        // row B's menu opens. Exactly ONE menu on screen — not two stacked.
        rightClick(rows[1], 60, 60);
        expect(menuCount()).toBe(1);
    });

    it('closes the menu on a plain left-click anywhere outside it', () => {
        const { container } = render(
            <ChatItem chat={chatA} active={false} collapsed={false} onClick={() => {}} onRemove={() => {}} onHideInVault={() => {}} />
        );
        const row = container.querySelector('.cursor-pointer')!;
        rightClick(row, 50, 50);
        expect(menuCount()).toBe(1);

        // Click on unrelated empty space (not the row, not the menu).
        fireEvent.mouseDown(document.body);
        expect(menuCount()).toBe(0);
    });

    it('keeps the menu open on mousedown INSIDE the menu (submenu/drag-safe)', () => {
        const { container } = render(
            <ChatItem chat={chatA} active={false} collapsed={false} onClick={() => {}} onRemove={() => {}} onHideInVault={() => {}} />
        );
        const row = container.querySelector('.cursor-pointer')!;
        rightClick(row, 50, 50);
        expect(menuCount()).toBe(1);

        const menuButton = screen.getByText('Hide in Vault');
        fireEvent.mouseDown(menuButton);
        expect(menuCount()).toBe(1);
    });

    it('re-opens (repositions) on a second right-click of the same row', () => {
        const { container } = render(
            <ChatItem chat={chatA} active={false} collapsed={false} onClick={() => {}} onRemove={() => {}} onHideInVault={() => {}} />
        );
        const row = container.querySelector('.cursor-pointer')!;
        rightClick(row, 50, 50);
        rightClick(row, 300, 300);
        // The document mousedown closes it, the contextmenu re-opens it: exactly one menu.
        expect(menuCount()).toBe(1);
    });
});

describe('PublicChannelItem context menu close-on-outside', () => {
    it('closes the open menu when another row is right-clicked (no stacked menus)', () => {
        const { container } = render(
            <div>
                <PublicChannelItem channel={pubA} active={false} collapsed={false} onClick={() => {}} onRemove={() => {}} onHideInVault={() => {}} />
                <PublicChannelItem channel={pubB} active={false} collapsed={false} onClick={() => {}} onRemove={() => {}} onHideInVault={() => {}} />
            </div>
        );
        const rows = container.querySelectorAll('.cursor-pointer');
        expect(rows.length).toBe(2);

        rightClick(rows[0], 50, 50);
        expect(menuCount()).toBe(1);

        rightClick(rows[1], 60, 60);
        expect(menuCount()).toBe(1);
    });

    it('closes the menu on a plain left-click anywhere outside it', () => {
        const { container } = render(
            <PublicChannelItem channel={pubA} active={false} collapsed={false} onClick={() => {}} onRemove={() => {}} onHideInVault={() => {}} />
        );
        const row = container.querySelector('.cursor-pointer')!;
        rightClick(row, 50, 50);
        expect(menuCount()).toBe(1);

        fireEvent.mouseDown(document.body);
        expect(menuCount()).toBe(0);
    });

    it('keeps the menu open on mousedown INSIDE the menu', () => {
        const { container } = render(
            <PublicChannelItem channel={pubA} active={false} collapsed={false} onClick={() => {}} onRemove={() => {}} onHideInVault={() => {}} />
        );
        const row = container.querySelector('.cursor-pointer')!;
        rightClick(row, 50, 50);

        const menuButton = screen.getByText('Hide in Vault');
        fireEvent.mouseDown(menuButton);
        expect(menuCount()).toBe(1);
    });
});
