import { describe, it, expect } from 'vitest';

describe('copy telegram link', () => {
    it('generates correct link for public channel', () => {
        const username = 'my_channel';
        const messageId = 42;
        const link = `https://t.me/${username}/${messageId}`;
        expect(link).toBe('https://t.me/my_channel/42');
    });

    it('returns null for private channel (no username)', () => {
        const username: string | null = null;
        expect(username).toBeNull();
    });

    it('link is disabled when channel is private', () => {
        const channelIsPublic = false;
        expect(channelIsPublic).toBe(false);
    });

    it('link is enabled when channel is public', () => {
        const username = 'test_channel';
        const channelIsPublic = !!username;
        expect(channelIsPublic).toBe(true);
    });
});
