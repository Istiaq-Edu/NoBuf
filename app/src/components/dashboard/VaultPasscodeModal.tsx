import { useState } from 'react';
import { Lock, X, ShieldAlert } from 'lucide-react';

interface VaultPasscodeModalProps {
    /** 'create' = first-hide setup (sets passcode + applies pending hide). */
    mode: 'create';
    title: string;
    description: string;
    submitLabel: string;
    /** Return true when the passcode was accepted (dialog closes). */
    onSubmit: (passcode: string) => Promise<boolean>;
    onClose: () => void;
}

/**
 * Create-passcode dialog (D16). Numeric 4-12 digits, enforced again by the
 * backend; the confirm field guards against typos since there is no "current
 * passcode" prompt on first creation.
 */
export function VaultPasscodeModal({ title, description, submitLabel, onSubmit, onClose }: VaultPasscodeModalProps) {
    const [passcode, setPasscode] = useState('');
    const [confirmPasscode, setConfirmPasscode] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    const valid = /^\d{4,12}$/.test(passcode);
    const matches = passcode === confirmPasscode;

    const submit = async () => {
        if (!valid) { setError('Passcode must be 4-12 digits'); return; }
        if (!matches) { setError('Passcodes do not match'); return; }
        setSubmitting(true);
        const ok = await onSubmit(passcode);
        setSubmitting(false);
        if (!ok) setError('Could not set passcode — try again');
    };

    return (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
            <div
                className="bg-nobuf-surface border border-nobuf-border rounded-xl w-[calc(100vw-2rem)] max-w-80 shadow-2xl overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                <div className="p-4 border-b border-nobuf-border flex justify-between items-center">
                    <div className="flex items-center gap-2">
                        <Lock className="w-4 h-4 text-nobuf-primary" />
                        <h3 className="text-nobuf-text font-medium">{title}</h3>
                    </div>
                    <button onClick={onClose} className="text-nobuf-subtext hover:text-nobuf-text">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="p-4 space-y-3">
                    <p className="text-xs text-nobuf-subtext">{description}</p>

                    <input
                        autoFocus
                        type="password"
                        inputMode="numeric"
                        autoComplete="new-password"
                        placeholder="Passcode (4-12 digits)"
                        className="w-full bg-nobuf-bg rounded-lg px-3 py-2 text-sm text-nobuf-text placeholder:text-nobuf-subtext focus:outline-none focus:ring-2 focus:ring-nobuf-primary/40 border border-nobuf-border"
                        value={passcode}
                        onChange={e => { setPasscode(e.target.value.replace(/\D/g, '').slice(0, 12)); setError(null); }}
                        onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                    />
                    <input
                        type="password"
                        inputMode="numeric"
                        autoComplete="new-password"
                        placeholder="Confirm passcode"
                        className="w-full bg-nobuf-bg rounded-lg px-3 py-2 text-sm text-nobuf-text placeholder:text-nobuf-subtext focus:outline-none focus:ring-2 focus:ring-nobuf-primary/40 border border-nobuf-border"
                        value={confirmPasscode}
                        onChange={e => { setConfirmPasscode(e.target.value.replace(/\D/g, '').slice(0, 12)); setError(null); }}
                        onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                    />

                    {error && (
                        <div className="flex items-center gap-1.5 text-xs text-red-400">
                            <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                            {error}
                        </div>
                    )}

                    <div className="flex gap-2 pt-1">
                        <button
                            onClick={submit}
                            disabled={!valid || !matches || submitting}
                            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium bg-nobuf-primary text-nobuf-county-green rounded-lg hover:brightness-110 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            <Lock className="w-3.5 h-3.5" />
                            {submitLabel}
                        </button>
                        <button
                            onClick={onClose}
                            className="px-3 py-2 text-xs font-medium text-nobuf-subtext hover:text-nobuf-text bg-nobuf-bg border border-nobuf-border rounded-lg transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
