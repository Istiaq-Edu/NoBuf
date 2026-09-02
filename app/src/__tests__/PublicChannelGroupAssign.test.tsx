// @vitest-environment jsdom
/**
 * Public-channel group-assignment regression tests (D9 parity).
 *
 * Gap (reported 2026-09-02): public channels couldn't be assigned to colored
 * groups while folders (D9) and chats could. The fix adds the ChatItem-style
 * "Move to Group" submenu to PublicChannelItem, backed by
 * cmd_assign_public_channel_to_group + cmd_get_enriched_public_channels.
 *
 * These tests pin the SHIPPED wiring: the submenu renders only when
 * onAssignGroup is provided, invoking a group invokes the handler with the
 * group id, "None" passes null, and the current assignment is highlighted.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, fireEvent, screen } from '@testing-library/react';
import { PublicChannelItem } from '../components/dashboard/PublicChannelItem';
import { PublicChannel } from '../types';

const pub: PublicChannel = { channel_id: 7, name: 'Chan', username: 'chan', access_hash: 100, is_private: false, added_at: 0, is_member: true };

const groups = [
    { id: 1, name: 'News', color_hex: '#22c55e' },
    { id: 2, name: 'Dev', color_hex: '#3b82f6' },
];

// cmd_get_groups returns the group list for the submenu.
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(async (cmd: string) => {
        if (cmd === 'cmd_get_groups') return groups;
        return [];
    }),
}));

const rightClick = (el: Element, x = 50, y = 50) => {
    fireEvent.mouseDown(el, { button: 2, clientX: x, clientY: y });
    fireEvent.contextMenu(el, { button: 2, clientX: x, clientY: y });
};

afterEach(cleanup);

describe('PublicChannelItem group assignment (D9 parity)', () => {
    it('shows "Move to Group" in the context menu when onAssignGroup is provided', () => {
        const { container } = render(
            <PublicChannelItem channel={pub} active={false} collapsed={false} onClick={() => {}} onRemove={() => {}} onAssignGroup={() => {}} />
        );
        rightClick(container.querySelector('.cursor-pointer')!);
        expect(screen.getByText('Move to Group')).toBeTruthy();
    });

    it('no submenu entry when onAssignGroup is absent (menu stays minimal)', () => {
        const { container } = render(
            <PublicChannelItem channel={pub} active={false} collapsed={false} onClick={() => {}} onRemove={() => {}} onHideInVault={() => {}} />
        );
        rightClick(container.querySelector('.cursor-pointer')!);
        expect(screen.queryByText('Move to Group')).toBeNull();
        // Hide in Vault still there
        expect(screen.getByText('Hide in Vault')).toBeTruthy();
    });

    it('invokes onAssignGroup with the group id when a group is clicked', async () => {
        const assign = vi.fn();
        const { container } = render(
            <PublicChannelItem channel={pub} active={false} collapsed={false} onClick={() => {}} onRemove={() => {}} onAssignGroup={assign} />
        );
        rightClick(container.querySelector('.cursor-pointer')!);
        fireEvent.click(screen.getByText('Move to Group'));
        // Groups load via async invoke (useEffect) — await them.
        fireEvent.click(await screen.findByText('Dev'));
        expect(assign).toHaveBeenCalledWith(2);
    });

    it('invokes onAssignGroup(null) on "None"', async () => {
        const assign = vi.fn();
        const { container } = render(
            <PublicChannelItem channel={pub} active={false} collapsed={false} onClick={() => {}} onRemove={() => {}} onAssignGroup={assign} />
        );
        rightClick(container.querySelector('.cursor-pointer')!);
        fireEvent.click(screen.getByText('Move to Group'));
        await screen.findByText('Dev'); // wait for load, then click None
        fireEvent.click(screen.getByText('None'));
        expect(assign).toHaveBeenCalledWith(null);
    });

    it('highlights the current group (currentGroupId)', async () => {
        const { container } = render(
            <PublicChannelItem channel={pub} active={false} collapsed={false} onClick={() => {}} onRemove={() => {}} onAssignGroup={() => {}} currentGroupId={1} groupColor="#22c55e" />
        );
        rightClick(container.querySelector('.cursor-pointer')!);
        fireEvent.click(screen.getByText('Move to Group'));
        await screen.findByText('Dev');
        // Current group row carries the primary highlight class.
        const devRow = screen.getByText('Dev').closest('button')!;
        expect(devRow.className).not.toContain('text-nobuf-primary');
        const newsRow = screen.getByText('News').closest('button')!;
        expect(newsRow.className).toContain('text-nobuf-primary');
    });
});
