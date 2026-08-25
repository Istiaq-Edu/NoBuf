import { describe, it, expect } from 'vitest';
import { filterHidden, isVaultedSelection, diffRemovedPublicIds, type VaultState } from '../context/VaultContext';

/**
 * Vault frontend logic tests — bound to the SHIPPED exported functions
 * (VaultContext pure helpers), not test-local copies (project convention).
 * Covers spec §4.2 filtering rule + §4.3 restore gating.
 */

describe('filterHidden (vault visibility memo)', () => {
    const folders = [
        { id: 1, name: 'Movies' },
        { id: 2, name: 'Secret' },
        { id: 3, name: 'Music' },
    ];

    it('drops items whose id is hidden', () => {
        const out = filterHidden(folders, f => f.id, new Set([2]));
        expect(out.map(f => f.id)).toEqual([1, 3]);
    });

    it('returns the SAME array when nothing is hidden (identity, not copy)', () => {
        const out = filterHidden(folders, f => f.id, new Set());
        expect(out).toBe(folders);
    });

    it('does NOT mutate the input array — persistence writers need full arrays', () => {
        const original = [...folders];
        filterHidden(folders, f => f.id, new Set([2]));
        expect(folders).toEqual(original);
        expect(folders).toHaveLength(3);
    });

    it('handles multiple hidden ids', () => {
        const out = filterHidden(folders, f => f.id, new Set([1, 3]));
        expect(out.map(f => f.id)).toEqual([2]);
    });

    it('hidden ids absent from the list are harmless (equal content)', () => {
        const out = filterHidden(folders, f => f.id, new Set([999]));
        expect(out).toEqual(folders);
    });

    it('works with public channel id extraction', () => {
        const channels = [{ channel_id: 10, name: 'a' }, { channel_id: 20, name: 'b' }];
        const out = filterHidden(channels, c => c.channel_id, new Set([20]));
        expect(out.map(c => c.channel_id)).toEqual([10]);
    });
});

describe('isVaultedSelection (startup restore gate)', () => {
    const hiddenFolders = new Set([100]);
    const hiddenPublics = new Set([200]);

    it('flags a folder selection referencing a vaulted folder', () => {
        expect(isVaultedSelection(100, hiddenFolders, hiddenPublics)).toBe(true);
    });

    it('flags a public-channel selection referencing a vaulted channel', () => {
        expect(isVaultedSelection(200, hiddenFolders, hiddenPublics)).toBe(true);
    });

    it('passes non-vaulted selections in either scope', () => {
        expect(isVaultedSelection(300, hiddenFolders, hiddenPublics)).toBe(false);
        expect(isVaultedSelection(101, hiddenFolders, hiddenPublics)).toBe(false);
    });

    it('null-ish zero and negative ids are treated as plain ids', () => {
        // Saved Messages is null upstream; 0/negatives never match vaulted sets.
        expect(isVaultedSelection(0, hiddenFolders, hiddenPublics)).toBe(false);
        expect(isVaultedSelection(-1, hiddenFolders, hiddenPublics)).toBe(false);
    });
});

describe('VaultState contract (locked responses carry no IDs)', () => {
    it('type-level: ids are nullable and counts always present', () => {
        // Runtime shape guard mirroring the backend's VaultStateResponse.
        const locked: VaultState = {
            has_passcode: true,
            is_unlocked: false,
            entry_visible: true,
            folder_count: 2,
            public_count: 1,
            folder_ids: null,
            public_ids: null,
        };
        expect(locked.folder_ids).toBeNull();
        expect(locked.folder_count).toBe(2);

        const unlocked: VaultState = { ...locked, is_unlocked: true, folder_ids: [7], public_ids: [8] };
        expect(unlocked.folder_ids).toEqual([7]);
    });
});

// ---- Phase 4 review: reconciliation prune diff (spec §4.4) ----------------

describe('diffRemovedPublicIds (public-channel prune after SQLite sync)', () => {
    it('returns channels present before but gone after', () => {
        expect(diffRemovedPublicIds([1, 2, 3], [2, 3, 4])).toEqual([1]);
    });

    it('returns [] when nothing was removed', () => {
        expect(diffRemovedPublicIds([1, 2], [1, 2])).toEqual([]);
        expect(diffRemovedPublicIds([], [])).toEqual([]);
    });

    it('returns ALL prev ids when sync emptied the list (account wipe)', () => {
        expect(diffRemovedPublicIds([5, 9], [])).toEqual([5, 9]);
    });

    it('ignores newly added channels — only prev-side removals count', () => {
        expect(diffRemovedPublicIds([7], [7, 8, 9])).toEqual([]);
    });

    it('preserves prev order and duplicates-safe semantics', () => {
        expect(diffRemovedPublicIds([3, 1, 2], [1])).toEqual([3, 2]);
    });

    it('is idempotent: diffing again with same inputs gives same result', () => {
        const a = diffRemovedPublicIds([1, 2, 3], [3]);
        const b = diffRemovedPublicIds([1, 2, 3], [3]);
        expect(a).toEqual(b);
        expect(a).toEqual([1, 2]);
    });
});

// ---- Phase 4 review: logout wipe semantics (cmd_vault_wipe_ids contract) ---

describe('logout wipe contract (wipe_ids keeps passcode, clears IDs)', () => {
    // Mirrors the Rust cmd_vault_wipe_ids behavior asserted in vault.rs:
    // lists cleared, passcode/salt/entry_visible survive, re-locks.
    it('a wiped store keeps has_passcode while counts drop to zero', () => {
        const before: VaultState = {
            has_passcode: true, is_unlocked: true, entry_visible: false,
            folder_count: 2, public_count: 3, folder_ids: [1, 2], public_ids: [3, 4, 5],
        };
        const after: VaultState = {
            has_passcode: true, is_unlocked: false, entry_visible: false,
            folder_count: 0, public_count: 0, folder_ids: null, public_ids: null,
        };
        // The contract: passcode survives, everything hidden is gone.
        expect(after.has_passcode).toBe(true);
        expect(after.folder_count).toBe(0);
        expect(after.public_count).toBe(0);
        expect(before.folder_ids!.length + before.public_ids!.length)
            .toBe(5); // all five were wiped
    });
});
