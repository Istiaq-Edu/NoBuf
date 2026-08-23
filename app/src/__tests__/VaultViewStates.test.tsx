// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { VaultView } from '../components/dashboard/VaultView';

/**
 * UI-state matrix test (added after the cold-entry bug: vault with no
 * passcode showed an UNLOCK prompt instead of passcode CREATION).
 * Locks the hasPasscode branch of the locked screen so the matrix
 * cannot silently regress again.
 */

// Hoist-safe mutable state: the mock factory runs before module vars exist,
// so the current vault object lives in vi.hoisted() storage.
const h = vi.hoisted(() => {
    const fns = {
        refresh: () => Promise.resolve({} as never),
        hide: () => Promise.resolve(),
        unhide: () => Promise.resolve(),
        verify: () => Promise.resolve(true),
        setPasscode: () => Promise.resolve(true),
        changePasscode: () => Promise.resolve(true),
        lock: () => Promise.resolve(),
        reset: () => Promise.resolve(),
        setEntryVisible: () => Promise.resolve(),
    };
    return {
        fns,
        current: {
            ready: true,
            isUnlocked: false,
            hasPasscode: true,
            entryVisible: true,
            folderCount: 0,
            publicCount: 0,
            totalCount: 0,
            hiddenFolderIds: new Set<number>(),
            hiddenPublicIds: new Set<number>(),
            ...fns,
        },
    };
});

function makeVault(hasPasscode: boolean) {
    h.current = {
        ...h.current,
        hasPasscode,
        isUnlocked: false,
        totalCount: 0,
    };
    return h.current;
}

vi.mock('../context/VaultContext', async () => {
    const actual = await vi.importActual<typeof import('../context/VaultContext')>('../context/VaultContext');
    return {
        ...actual,
        useVault: () => h.current,
    };
});

vi.mock('../../context/ConfirmContext', () => ({
    useConfirm: () => ({ confirm: () => Promise.resolve(false) }),
}));

// VaultView imports '../../context/ConfirmContext' relative to components/dashboard/
vi.mock('../components/dashboard/../../context/ConfirmContext', () => ({
    useConfirm: () => ({ confirm: () => Promise.resolve(false) }),
}));

describe('VaultView locked-screen state matrix', () => {
    beforeEach(() => {
        makeVault(true);
    });
    afterEach(() => {
        cleanup();
    });

    it('no passcode yet → shows CREATE prompt, not unlock', () => {
        makeVault(false);
        render(
            <VaultView
                onOpenFolder={() => {}}
                onOpenPublicChannel={() => {}}
                getFolderName={() => 'f'}
                getChannelName={() => 'c'}
            />
        );
        expect(screen.getByText('Create Vault passcode')).toBeTruthy();
        expect(screen.getByText('Create & Unlock')).toBeTruthy();
        // Nothing to reset before a passcode exists.
        expect(screen.queryByText(/Reset Vault/i)).toBeNull();
        // The bare "Unlock" label must NOT appear in creation mode
        // (Create & Unlock contains it as a substring — match exact node).
        expect(screen.queryByText((_, el) => el?.textContent === 'Unlock')).toBeNull();
    });

    it('passcode exists → shows UNLOCK screen with reset link', () => {
        makeVault(true);
        render(
            <VaultView
                onOpenFolder={() => {}}
                onOpenPublicChannel={() => {}}
                getFolderName={() => 'f'}
                getChannelName={() => 'c'}
            />
        );
        expect(screen.getByText('Vault is locked')).toBeTruthy();
        expect(screen.getByText('Unlock')).toBeTruthy();
        expect(screen.getByText(/Forgot passcode\? Reset Vault/i)).toBeTruthy();
        expect(screen.queryByText('Create & Unlock')).toBeNull();
        expect(screen.queryByText('Create Vault passcode')).toBeNull();
    });
});
