import { useState } from 'react';
import { Lock, Unlock, Folder, Radio, RotateCcw, KeyRound, LogOut, ChevronRight } from 'lucide-react';
import { useVault, type VaultKind } from '../../context/VaultContext';
import { useConfirm } from '../../context/ConfirmContext';

interface VaultViewProps {
    /** Navigate into a hidden folder/channel (only offered when unlocked). */
    onOpenFolder: (id: number) => void;
    onOpenPublicChannel: (id: number) => void;
    /** Resolve display names from the RAW (unfiltered) lists — hidden items
     *  never appear in visibleFolders/visiblePublicChannels. */
    getFolderName: (id: number) => string;
    getChannelName: (id: number) => string;
}

/**
 * The vault interior (spec §4.2). Locked → unlock screen (passcode + Reset
 * link with confirm, D8). Unlocked → list of hidden items with unhide /
 * open actions, change-passcode, Lock-now (D12).
 */
export function VaultView({ onOpenFolder, onOpenPublicChannel, getFolderName, getChannelName }: VaultViewProps) {
    const vault = useVault();
    const { confirm } = useConfirm();
    const [passcode, setPasscode] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    // ---- Locked: unlock screen ------------------------------------------
    if (!vault.isUnlocked) {
        const submit = async () => {
            if (!/^\d{4,12}$/.test(passcode)) { setError('4-12 digits'); return; }
            setBusy(true);
            const ok = vault.hasPasscode ? await vault.verify(passcode) : await createPasscode(passcode);
            setBusy(false);
            if (!ok) setError(vault.hasPasscode ? 'Wrong passcode' : 'Could not set passcode');
            else { setPasscode(''); setError(null); }
        };

        // D16 entry path: no passcode exists yet — the lock screen IS the
        // creation screen (set_passcode allows first-time set while locked).
        const createPasscode = async (passcode: string): Promise<boolean> => {
            return vault.setPasscode(passcode);
        };

        const resetVault = async () => {
            const confirmed = await confirm({
                title: 'Reset Vault',
                message: 'The passcode is cleared and ALL hidden channels return to their normal sections. Your files on Telegram are NOT touched.',
                confirmText: 'Reset Vault',
                variant: 'danger',
            });
            if (!confirmed) return;
            setBusy(true);
            await vault.reset();
            setBusy(false);
        };

        return (
            <div className="flex-1 flex items-center justify-center p-6">
                <div className="w-full max-w-xs bg-nobuf-surface border border-nobuf-border rounded-xl p-5 space-y-3 text-center">
                    <div className="w-12 h-12 mx-auto rounded-full bg-nobuf-primary/10 flex items-center justify-center">
                        <Lock className="w-6 h-6 text-nobuf-primary" />
                    </div>
                    <h2 className="text-nobuf-text font-medium">{vault.hasPasscode ? 'Vault is locked' : 'Create Vault passcode'}</h2>
                    <p className="text-xs text-nobuf-subtext">
                        {vault.hasPasscode
                            ? (vault.totalCount > 0 ? `${vault.totalCount} hidden ${vault.totalCount === 1 ? 'item' : 'items'}` : 'Nothing hidden yet')
                            : 'Choose a 4-12 digit passcode to protect hidden channels'}
                    </p>
                    <input
                        autoFocus
                        type="password"
                        inputMode="numeric"
                        placeholder={vault.hasPasscode ? 'Passcode' : 'New passcode (4-12 digits)'}
                        className="w-full bg-nobuf-bg rounded-lg px-3 py-2 text-sm text-nobuf-text placeholder:text-nobuf-subtext focus:outline-none focus:ring-2 focus:ring-nobuf-primary/40 border border-nobuf-border text-center tracking-widest"
                        value={passcode}
                        onChange={e => { setPasscode(e.target.value.replace(/\D/g, '').slice(0, 12)); setError(null); }}
                        onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                    />
                    {error && <p className="text-xs text-red-400">{error}</p>}
                    <button
                        onClick={submit}
                        disabled={busy || passcode.length === 0}
                        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium bg-nobuf-primary text-nobuf-county-green rounded-lg hover:brightness-110 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        <Unlock className="w-3.5 h-3.5" />
                        {vault.hasPasscode ? 'Unlock' : 'Create & Unlock'}
                    </button>
                    {vault.hasPasscode && (
                        <button
                            onClick={resetVault}
                            className="text-[11px] text-nobuf-subtext hover:text-red-400 transition-colors underline underline-offset-2"
                        >
                            Forgot passcode? Reset Vault
                        </button>
                    )}
                </div>
            </div>
        );
    }

    // ---- Unlocked: hidden items + actions (D12) -------------------------
    const folderItems: number[] = Array.from(vault.hiddenFolderIds);
    const publicItems: number[] = Array.from(vault.hiddenPublicIds);
    const empty = vault.totalCount === 0;

    return (
        <div className="flex-1 overflow-y-auto sidebar-scroll p-6 space-y-5">
            {/* Action bar */}
            <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-nobuf-text flex items-center gap-1.5 flex-1">
                    <Unlock className="w-4 h-4 text-nobuf-primary" />
                    Vault — {vault.totalCount} hidden
                </span>
                <ChangePasscodeControl />
                <button
                    onClick={() => vault.lock()}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-nobuf-subtext hover:text-nobuf-text bg-nobuf-bg border border-nobuf-border rounded-lg transition-colors"
                >
                    <LogOut className="w-3.5 h-3.5" />
                    Lock now
                </button>
            </div>

            {empty && (
                <div className="text-center py-16 text-nobuf-subtext">
                    <Lock className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">Nothing hidden yet.</p>
                    <p className="text-xs mt-1 opacity-70">Right-click a channel in the sidebar and choose "Hide in Vault".</p>
                </div>
            )}

            {folderItems.length > 0 && (
                <section>
                    <h3 className="text-xs font-semibold text-nobuf-subtext uppercase tracking-wider px-1 pb-2">Private Channels</h3>
                    <div className="space-y-1">
                        {folderItems.map(id => (
                            <HiddenRow
                                key={`f-${id}`}
                                icon={Folder}
                                label={getFolderName(id)}
                                kindLabel="private channel"
                                onOpen={() => onOpenFolder(id)}
                                onUnhide={() => vault.unhide('folder' as VaultKind, id)}
                            />
                        ))}
                    </div>
                </section>
            )}

            {publicItems.length > 0 && (
                <section>
                    <h3 className="text-xs font-semibold text-nobuf-subtext uppercase tracking-wider px-1 pb-2">Public Channels</h3>
                    <div className="space-y-1">
                        {publicItems.map(id => (
                            <HiddenRow
                                key={`p-${id}`}
                                icon={Radio}
                                label={getChannelName(id)}
                                kindLabel="public channel"
                                onOpen={() => onOpenPublicChannel(id)}
                                onUnhide={() => vault.unhide('public_channel' as VaultKind, id)}
                            />
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
}

function HiddenRow({ icon: Icon, label, kindLabel, onOpen, onUnhide }: {
    icon: React.ElementType;
    label: string;
    kindLabel: string;
    onOpen: () => void;
    onUnhide: () => void;
}) {
    return (
        <div className="group flex items-center gap-3 px-3 py-2.5 rounded-lg bg-nobuf-surface border border-nobuf-border hover:border-nobuf-primary/40 transition-colors">
            <Icon className="w-4 h-4 shrink-0 text-nobuf-subtext" />
            <span className="flex-1 text-sm text-nobuf-text truncate">{label}</span>
            <button
                onClick={onOpen}
                className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-nobuf-subtext hover:text-nobuf-primary rounded-md hover:bg-nobuf-hover transition-colors"
            >
                Open <ChevronRight className="w-3 h-3" />
            </button>
            <button
                onClick={onUnhide}
                className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-nobuf-subtext hover:text-red-400 rounded-md hover:bg-red-500/10 transition-colors"
                title={`Remove from Vault — returns to normal ${kindLabel} section`}
            >
                <RotateCcw className="w-3 h-3" />
                Unhide
            </button>
        </div>
    );
}

/** Change-passcode inline control (D12). New + confirm, no current-passcode prompt. */
function ChangePasscodeControl() {
    const vault = useVault();
    const [open, setOpen] = useState(false);
    const [a, setA] = useState('');
    const [b, setB] = useState('');
    const [error, setError] = useState<string | null>(null);

    const submit = async () => {
        if (!/^\d{4,12}$/.test(a)) { setError('4-12 digits'); return; }
        if (a !== b) { setError('Passcodes do not match'); return; }
        const ok = await vault.changePasscode(a);
        if (!ok) { setError('Could not change passcode'); return; }
        setOpen(false); setA(''); setB(''); setError(null);
    };

    if (!open) {
        return (
            <button
                onClick={() => setOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-nobuf-subtext hover:text-nobuf-text bg-nobuf-bg border border-nobuf-border rounded-lg transition-colors"
            >
                <KeyRound className="w-3.5 h-3.5" />
                Change passcode
            </button>
        );
    }

    return (
        <div className="flex items-center gap-1.5" onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}>
            <input
                autoFocus type="password" inputMode="numeric" placeholder="New passcode"
                className="w-28 bg-nobuf-bg rounded-lg px-2 py-1.5 text-xs text-nobuf-text placeholder:text-nobuf-subtext focus:outline-none focus:ring-2 focus:ring-nobuf-primary/40 border border-nobuf-border"
                value={a} onChange={e => { setA(e.target.value.replace(/\D/g, '').slice(0, 12)); setError(null); }}
            />
            <input
                type="password" inputMode="numeric" placeholder="Confirm"
                className="w-24 bg-nobuf-bg rounded-lg px-2 py-1.5 text-xs text-nobuf-text placeholder:text-nobuf-subtext focus:outline-none focus:ring-2 focus:ring-nobuf-primary/40 border border-nobuf-border"
                value={b} onChange={e => { setB(e.target.value.replace(/\D/g, '').slice(0, 12)); setError(null); }}
                onKeyDown={e => { if (e.key === 'Enter') submit(); }}
            />
            <button onClick={submit} className="px-2.5 py-1.5 text-xs font-medium bg-nobuf-primary text-nobuf-county-green rounded-lg hover:brightness-110 active:scale-95 transition-all">Save</button>
            <button onClick={() => { setOpen(false); setError(null); }} className="px-2 py-1.5 text-xs text-nobuf-subtext hover:text-nobuf-text rounded-lg hover:bg-nobuf-hover transition-colors">Cancel</button>
            {error && <span className="text-[11px] text-red-400">{error}</span>}
        </div>
    );
}
