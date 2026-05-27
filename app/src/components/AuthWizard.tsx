import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";
import { Phone, Key, Lock, ArrowRight, Settings, ShieldCheck, Sun, Moon, ExternalLink, QrCode, Cloud, Play, HardDrive } from "lucide-react";
import { load } from '@tauri-apps/plugin-store';
import { useTheme } from '../context/ThemeContext';
import { open } from '@tauri-apps/plugin-shell';
import { QRCodeSVG } from 'qrcode.react';

type Step = "setup" | "phone" | "code" | "password";

function AuthThemeToggle() {
    const { theme, toggleTheme } = useTheme();
    return (
        <button
            onClick={toggleTheme}
            className="absolute top-4 right-4 p-3 rounded-full bg-nobuf-primary/10 hover:bg-nobuf-primary/20 transition-colors z-10"
            title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
        >
            {theme === 'dark' ? (
                <Sun className="w-5 h-5 text-nobuf-primary" />
            ) : (
                <Moon className="w-5 h-5 text-nobuf-primary" />
            )}
        </button>
    );
}

/* ── Right Panel: Setup Guide ──────────────────────────── */
function SetupGuide() {
    return (
        <div className="space-y-6">
            <div className="p-4 bg-nobuf-primary/10 border border-nobuf-primary/20 rounded-xl">
                <p className="text-sm text-nobuf-subtext">
                    <strong className="text-nobuf-primary">NoBuf</strong> uses your Telegram account as secure cloud storage. You'll need a Telegram account and API credentials to get started.
                </p>
            </div>

            <div className="space-y-5">
                <div className="space-y-2">
                    <h3 className="font-semibold flex items-center gap-2 text-nobuf-text">
                        <span className="w-6 h-6 bg-nobuf-primary text-nobuf-county-green text-xs font-bold rounded-full flex items-center justify-center">1</span>
                        Go to Telegram's Developer Portal
                    </h3>
                    <p className="text-sm text-nobuf-subtext ml-8">
                        Visit <button type="button" onClick={(e) => { e.preventDefault(); open('https://my.telegram.org'); }} className="text-nobuf-primary underline hover:text-nobuf-text cursor-pointer">my.telegram.org</button> and log in with your phone number.
                    </p>
                </div>

                <div className="space-y-2">
                    <h3 className="font-semibold flex items-center gap-2 text-nobuf-text">
                        <span className="w-6 h-6 bg-nobuf-primary text-nobuf-county-green text-xs font-bold rounded-full flex items-center justify-center">2</span>
                        Create a New Application
                    </h3>
                    <p className="text-sm text-nobuf-subtext ml-8">
                        Click on <strong>"API development tools"</strong> and create a new application. Use any name and description you like.
                    </p>
                </div>

                <div className="space-y-2">
                    <h3 className="font-semibold flex items-center gap-2 text-nobuf-text">
                        <span className="w-6 h-6 bg-nobuf-primary text-nobuf-county-green text-xs font-bold rounded-full flex items-center justify-center">3</span>
                        Copy Your Credentials
                    </h3>
                    <p className="text-sm text-nobuf-subtext ml-8">
                        After creating the app, you'll see your <strong>API ID</strong> (a number) and <strong>API Hash</strong> (a string). Copy both and paste them into the fields on the left.
                    </p>
                </div>
            </div>

            <div className="p-4 bg-nobuf-hover rounded-xl border border-nobuf-border">
                <p className="text-xs text-nobuf-subtext">
                    <strong>🔒 Privacy:</strong> Your credentials are stored locally on your device and are never sent to any third-party servers. All data goes directly between you and Telegram.
                </p>
            </div>

            <button
                type="button"
                onClick={(e) => { e.preventDefault(); open('https://my.telegram.org'); }}
                className="auth-btn-shine w-full bg-nobuf-primary text-nobuf-county-green font-semibold py-3 rounded-xl flex items-center justify-center gap-2 hover:bg-nobuf-primary/90 transition-colors"
            >
                <ExternalLink className="w-4 h-4" />
                Open my.telegram.org
            </button>
        </div>
    );
}

/* ── Right Panel: Phone Context ──────────────────────────── */
function PhoneContext() {
    return (
        <div className="space-y-6">
            <h2 className="text-lg font-semibold text-nobuf-text">Verify Your Identity</h2>
            <p className="text-sm text-nobuf-subtext leading-relaxed">
                Telegram will send a verification code to confirm your identity. You can receive it via:
            </p>
            <div className="space-y-3">
                <div className="flex items-start gap-3 p-3 bg-nobuf-primary/5 rounded-lg border border-nobuf-primary/10">
                    <Phone className="w-4 h-4 text-nobuf-primary mt-0.5 shrink-0" />
                    <div>
                        <p className="text-sm font-medium text-nobuf-text">Telegram App Notification</p>
                        <p className="text-xs text-nobuf-subtext">The code appears as an in-app message from Telegram itself.</p>
                    </div>
                </div>
                <div className="flex items-start gap-3 p-3 bg-nobuf-hover rounded-lg border border-nobuf-border">
                    <span className="text-sm font-bold text-nobuf-secondary mt-0.5 shrink-0">SMS</span>
                    <div>
                        <p className="text-sm font-medium text-nobuf-text">SMS Fallback</p>
                        <p className="text-xs text-nobuf-subtext">If you don't receive the in-app message, Telegram sends it via SMS.</p>
                    </div>
                </div>
            </div>

            <div className="p-4 bg-nobuf-hover rounded-xl border border-nobuf-border mt-4">
                <p className="text-xs text-nobuf-subtext">
                    <strong>🔒 Privacy:</strong> Your phone number and credentials are stored locally. No data is sent to third-party servers.
                </p>
            </div>

            <div className="space-y-4 mt-4">
                <h3 className="text-sm font-semibold text-nobuf-text">What you get with NoBuf</h3>
                <div className="flex items-start gap-3">
                    <Play className="w-4 h-4 text-nobuf-primary shrink-0" />
                    <p className="text-xs text-nobuf-subtext">Zero-buffer video streaming from Telegram's servers</p>
                </div>
                <div className="flex items-start gap-3">
                    <Cloud className="w-4 h-4 text-nobuf-primary shrink-0" />
                    <p className="text-xs text-nobuf-subtext">Unlimited cloud storage via your Telegram account</p>
                </div>
                <div className="flex items-start gap-3">
                    <HardDrive className="w-4 h-4 text-nobuf-primary shrink-0" />
                    <p className="text-xs text-nobuf-subtext">REST API for programmatic access and AI integration</p>
                </div>
            </div>
        </div>
    );
}

/* ── Right Panel: Code Context ──────────────────────────── */
function CodeContext({ phone }: { phone: string }) {
    return (
        <div className="space-y-6">
            <h2 className="text-lg font-semibold text-nobuf-text">Enter Your Verification Code</h2>
            <div className="p-4 bg-nobuf-primary/10 border border-nobuf-primary/20 rounded-xl">
                <p className="text-sm text-nobuf-subtext">
                    We sent a verification code to <strong className="text-nobuf-primary">{phone || 'your Telegram app'}</strong>.
                    Enter the 5-digit code in the field on the left.
                </p>
            </div>
            <div className="space-y-3">
                <h3 className="text-sm font-semibold text-nobuf-text">Where to find the code</h3>
                <div className="flex items-start gap-3 p-3 bg-nobuf-primary/5 rounded-lg border border-nobuf-primary/10">
                    <Phone className="w-4 h-4 text-nobuf-primary mt-0.5 shrink-0" />
                    <div>
                        <p className="text-sm font-medium text-nobuf-text">Telegram App</p>
                        <p className="text-xs text-nobuf-subtext">Check your chat list for a message from Telegram. The code appears as an unread message from "Telegram" itself.</p>
                    </div>
                </div>
                <div className="flex items-start gap-3 p-3 bg-nobuf-hover rounded-lg border border-nobuf-border">
                    <span className="text-sm font-bold text-nobuf-secondary mt-0.5 shrink-0">SMS</span>
                    <div>
                        <p className="text-sm font-medium text-nobuf-text">SMS Message</p>
                        <p className="text-xs text-nobuf-subtext">If no Telegram message arrived, check your SMS inbox for the code.</p>
                    </div>
                </div>
            </div>

            <div className="p-4 bg-nobuf-hover rounded-xl border border-nobuf-border">
                <p className="text-xs text-nobuf-subtext">
                    <strong>🔒 Privacy:</strong> The code is verified directly with Telegram's servers. It is never stored or transmitted elsewhere.
                </p>
            </div>
        </div>
    );
}

/* ── Right Panel: Password Context ──────────────────────────── */
function PasswordContext() {
    return (
        <div className="space-y-6">
            <h2 className="text-lg font-semibold text-nobuf-text">Two-Factor Authentication</h2>
            <div className="p-4 bg-nobuf-primary/10 border border-nobuf-primary/20 rounded-xl">
                <p className="text-sm text-nobuf-subtext">
                    Your Telegram account has <strong className="text-nobuf-primary">Two-Factor Authentication</strong> enabled. This is an extra security layer beyond the login code.
                </p>
            </div>
            <div className="space-y-3">
                <h3 className="text-sm font-semibold text-nobuf-text">What is 2FA?</h3>
                <p className="text-sm text-nobuf-subtext leading-relaxed">
                    Two-Factor Authentication (also called "cloud password") is a password you set up in Telegram that is required <em>after</em> the login code. It protects your account even if someone intercepts your SMS.
                </p>
                <div className="flex items-start gap-3 p-3 bg-nobuf-hover rounded-lg border border-nobuf-border">
                    <Lock className="w-4 h-4 text-nobuf-primary mt-0.5 shrink-0" />
                    <div>
                        <p className="text-sm font-medium text-nobuf-text">Cloud Password vs Local Password</p>
                        <p className="text-xs text-nobuf-subtext">This is the password you configured in Telegram's Settings &gt; Privacy &gt; Two-Step Verification. It is not a NoBuf-specific password.</p>
                    </div>
                </div>
            </div>

            <div className="p-4 bg-nobuf-hover rounded-xl border border-nobuf-border">
                <p className="text-xs text-nobuf-subtext">
                    <strong>🔒 Privacy:</strong> Your password is verified directly with Telegram. NoBuf never stores or sees your cloud password.
                </p>
            </div>
        </div>
    );
}

/* ── Right Panel: Flood Wait Context ──────────────────────────── */
function FloodWaitContext() {
    return (
        <div className="space-y-6">
            <h2 className="text-lg font-semibold text-nobuf-text">Rate Limit Reached</h2>
            <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl">
                <p className="text-sm text-nobuf-subtext">
                    Telegram has temporarily limited login attempts from this device. This is a safety mechanism to prevent abuse.
                </p>
            </div>
            <div className="space-y-3">
                <h3 className="text-sm font-semibold text-nobuf-text">What happened?</h3>
                <p className="text-sm text-nobuf-subtext leading-relaxed">
                    Too many authentication requests were sent in a short period. Telegram enforces a cooldown to protect accounts from unauthorized access attempts.
                </p>
            </div>
            <div className="p-4 bg-nobuf-hover rounded-xl border border-nobuf-border">
                <p className="text-xs text-nobuf-subtext">
                    <strong>⚠ Important:</strong> Do not restart the app during the wait period. The timer will reset if you do, requiring you to wait again from the beginning.
                </p>
            </div>
        </div>
    );
}

export function AuthWizard({ onLogin }: { onLogin: () => void }) {
    const isBrowser = typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window);

    if (isBrowser) {
        return (
            <div className="auth-gradient h-screen w-screen flex items-center justify-center p-6">
                <div className="auth-glass p-8 rounded-2xl shadow-2xl max-w-md w-full text-center">
                    <div className="w-20 h-20 bg-red-500/20 rounded-full flex items-center justify-center mb-6 mx-auto">
                        <ShieldCheck className="w-10 h-10 text-red-500" />
                    </div>
                    <h1 className="text-2xl font-bold text-nobuf-text mb-4">Desktop App Required</h1>
                    <p className="text-nobuf-subtext mb-6 leading-relaxed">
                        You are viewing the internal development server in a browser.
                        This application cannot function here because it requires access to the system backend (Rust).
                    </p>
                    <div className="p-4 bg-nobuf-hover rounded-xl border border-nobuf-border text-sm text-nobuf-subtext">
                        Please open the <strong className="text-nobuf-primary">NoBuf</strong> window in your OS taskbar/dock to continue.
                    </div>
                </div>
            </div>
        );
    }

    const [step, setStep] = useState<Step>("setup");
    const [loading, setLoading] = useState(false);
    const [apiId, setApiId] = useState("");
    const [apiHash, setApiHash] = useState("");
    const [phone, setPhone] = useState("");
    const [code, setCode] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [floodWait, setFloodWait] = useState<number | null>(null);
    const [loginMethod, setLoginMethod] = useState<'phone' | 'qr'>('phone');
    const [qrUrl, setQrUrl] = useState<string | null>(null);
    const [qrPolling, setQrPolling] = useState(false);
    const qrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        if (!floodWait) return;
        const interval = setInterval(() => {
            setFloodWait(prev => {
                if (prev === null || prev <= 1) return null;
                return prev - 1;
            });
        }, 1000);
        return () => clearInterval(interval);
    }, [floodWait]);

    useEffect(() => {
        const initStore = async () => {
            try {
                const store = await load('config.json');
                const savedId = await store.get<string>('api_id');
                const savedHash = await store.get<string>('api_hash');
                if (savedId && savedHash) {
                    setApiId(savedId);
                    setApiHash(savedHash);
                }
            } catch {
                // config not found, starting fresh
            }
        };
        initStore();
    }, []);

    const saveCredentials = async () => {
        try {
            const store = await load('config.json');
            await store.set('api_id', apiId);
            await store.set('api_hash', apiHash);
            await store.save();
        } catch {
            // store write failure, non-critical
        }
    };

    const handleSetupSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (apiId.includes(' ') || apiHash.includes(' ')) {
            setError("API ID and API Hash cannot contain spaces. Please remove any spaces.");
            return;
        }
        if (!apiId || !apiHash) {
            setError("Both API ID and Hash are required.");
            return;
        }
        setError(null);
        await saveCredentials();
        setStep("phone");
        setLoginMethod('phone');
        setQrUrl(null);
        setQrPolling(false);
    };

    const handleQrLogin = async () => {
        setError(null);
        setLoading(true);
        try {
            const idInt = parseInt(apiId, 10);
            if (isNaN(idInt)) throw new Error("API ID must be a number");
            const url = await invoke<string>("cmd_auth_qr_login", { apiId: idInt, apiHash: apiHash });
            if (url === "__authorized__") {
                onLogin();
                return;
            }
            setQrUrl(url);
            setQrPolling(true);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (!qrPolling) {
            if (qrPollRef.current) { clearInterval(qrPollRef.current); qrPollRef.current = null; }
            return;
        }
        qrPollRef.current = setInterval(async () => {
            try {
                const res = await invoke<{ success: boolean; next_step?: string }>("cmd_auth_qr_poll");
                if (res.success) {
                    setQrPolling(false);
                    if (res.next_step === "password") { setStep("password"); } else { onLogin(); }
                }
            } catch {
                // Polling error — keep trying silently
            }
        }, 3000);
        return () => { if (qrPollRef.current) { clearInterval(qrPollRef.current); qrPollRef.current = null; } };
    }, [qrPolling, apiId, apiHash]);

    const handlePhoneSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const idInt = parseInt(apiId, 10);
            if (isNaN(idInt)) throw new Error("API ID must be a number");
            await invoke("cmd_auth_request_code", { phone, apiId: idInt, apiHash: apiHash });
            setStep("code");
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : JSON.stringify(err);
            if (msg.includes("FLOOD_WAIT_")) {
                const parts = msg.split("FLOOD_WAIT_");
                if (parts[1]) {
                    const seconds = parseInt(parts[1]);
                    if (!isNaN(seconds)) { setFloodWait(seconds); return; }
                }
            }
            setError(msg);
        } finally { setLoading(false); }
    };

    const handleCodeSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const res = await invoke<{ success: boolean; next_step?: string }>("cmd_auth_sign_in", { code });
            if (res.success) { onLogin(); }
            else if (res.next_step === "password") { setStep("password"); }
            else { setError("Unknown error"); }
        } catch (err: unknown) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setLoading(false); }
    };

    const handlePasswordSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const res = await invoke<{ success: boolean; next_step?: string }>("cmd_auth_check_password", { password });
            if (res.success) { onLogin(); } else { setError("Password verification failed."); }
        } catch (err: unknown) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setLoading(false); }
    };

    return (
        <div className="auth-gradient h-screen w-screen relative overflow-hidden">
            <AuthThemeToggle />

            {/* Decorative blur orbs — premium layered depth */}
            <div className="fixed top-[-15%] left-[-8%] w-[600px] h-[600px] bg-nobuf-spring-green/10 rounded-full blur-[140px] pointer-events-none -z-10" />
            <div className="fixed bottom-[-15%] right-[-5%] w-[500px] h-[500px] bg-nobuf-ocean-green/12 rounded-full blur-[120px] pointer-events-none -z-10" />
            <div className="fixed top-[40%] right-[30%] w-[300px] h-[300px] bg-nobuf-charlotte/8 rounded-full blur-[100px] pointer-events-none -z-10" />

            {/* Logo banner — centered at top, spans both columns */}
            <div className="flex items-center justify-center gap-4 pt-6 pb-4 md:pt-10 md:pb-6 px-6">
                <div className="w-14 h-14 flex items-center justify-center filter drop-shadow-lg">
                    <img src="/logo.png" alt="NoBuf Logo" className="w-full h-full" />
                </div>
                <div>
                    <h1 className="text-2xl md:text-3xl font-bold text-nobuf-text tracking-tight">NoBuf</h1>
                </div>
            </div>

            {/* Split layout: Left = form, Right = contextual guide */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-0 px-6 pb-6" style={{ height: 'calc(100vh - 120px)' }}>
                {/* ── LEFT PANEL ── */}
                <div className="auth-glass p-4 md:p-8 rounded-2xl shadow-2xl flex flex-col overflow-y-auto">
                    <AnimatePresence mode="wait">
                        {floodWait ? (
                            <motion.div
                                key="flood"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                className="flex-1 flex flex-col items-center justify-center text-center space-y-6"
                            >
                                <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mx-auto animate-pulse">
                                    <span className="text-2xl">⏳</span>
                                </div>
                                <div>
                                    <h2 className="text-xl font-bold text-nobuf-text mb-2">Too Many Requests</h2>
                                    <p className="text-sm text-nobuf-subtext">Telegram has temporarily limited your actions.</p>
                                    <p className="text-sm text-nobuf-subtext">Please wait before trying again.</p>
                                </div>
                                <div className="text-5xl font-mono items-center justify-center flex text-nobuf-primary font-bold">
                                    {Math.floor(floodWait / 60)}:{(floodWait % 60).toString().padStart(2, '0')}
                                </div>
                                <p className="text-xs text-red-400/60">
                                    Do not restart the app. The timer will reset if you do.
                                </p>
                            </motion.div>
                        ) : (
                        <>
                            {step === "setup" && (
                                <motion.form
                                    key="setup"
                                    initial={{ x: 20, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    exit={{ x: -20, opacity: 0 }}
                                    onSubmit={handleSetupSubmit}
                                    className="flex-1 flex flex-col items-center justify-center space-y-5"
                                >
                                    <h2 className="text-lg font-semibold text-nobuf-text mb-2">Configure Your Credentials</h2>
                                    <div className="w-full max-w-sm space-y-4">
                                        <div>
                                            <label className="block text-xs font-semibold text-nobuf-subtext uppercase tracking-wider mb-2">API ID</label>
                                            <div className="relative">
                                                <Key className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 auth-form-icon" />
                                                <input
                                                    type="text"
                                                    value={apiId}
                                                    onChange={(e) => setApiId(e.target.value)}
                                                    placeholder="12345678"
                                                    className="w-full glass-input rounded-xl pl-12 pr-4 py-3.5 text-nobuf-text placeholder-nobuf-subtext/50 focus:outline-none focus:border-nobuf-primary transition-all font-mono text-sm"
                                                />
                                            </div>
                                        </div>
                                        <div>
                                            <label className="block text-xs font-semibold text-nobuf-subtext uppercase tracking-wider mb-2">API Hash</label>
                                            <div className="relative">
                                                <Key className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 auth-form-icon" />
                                                <input
                                                    type="text"
                                                    value={apiHash}
                                                    onChange={(e) => setApiHash(e.target.value)}
                                                    placeholder="abcdef123456..."
                                                    className="w-full glass-input rounded-xl pl-12 pr-4 py-3.5 text-nobuf-text placeholder-nobuf-subtext/50 focus:outline-none focus:border-nobuf-primary transition-all font-mono text-sm"
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    <button
                                        type="submit"
                                        className="auth-btn-shine w-full max-w-sm bg-nobuf-primary text-nobuf-county-green font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition-all shadow-lg shadow-nobuf-primary/20 active:scale-[0.98]"
                                    >
                                        Configure <Settings className="w-4 h-4" />
                                    </button>

                                    {import.meta.env.DEV && (
                                        <button
                                            type="button"
                                            onClick={() => onLogin()}
                                            className="w-full max-w-sm text-xs text-red-400/60 hover:text-red-300 transition-colors py-1"
                                        >
                                            Dev Mode
                                        </button>
                                    )}
                                </motion.form>
                            )}

                            {step === "phone" && (
                                <motion.div
                                    key="phone"
                                    initial={{ x: 20, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    exit={{ x: -20, opacity: 0 }}
                                    className="flex-1 flex flex-col items-center justify-center space-y-5"
                                >
                                    <div className="w-full max-w-sm space-y-6">
                                        <PhoneQrToggle
                                            loginMethod={loginMethod}
                                            setLoginMethod={setLoginMethod}
                                            setQrUrl={setQrUrl}
                                            setQrPolling={setQrPolling}
                                            setError={setError}
                                            handleQrLogin={handleQrLogin}
                                        />

                                        {loginMethod === 'phone' ? (
                                            <form onSubmit={handlePhoneSubmit} className="space-y-5">
                                                <div className="space-y-2">
                                                    <label className="block text-xs font-semibold text-nobuf-subtext uppercase tracking-wider">Phone Number</label>
                                                    <div className="relative">
                                                        <Phone className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 auth-form-icon" />
                                                        <input
                                                            type="tel"
                                                            value={phone}
                                                            onChange={(e) => setPhone(e.target.value)}
                                                            placeholder="+1 234 567 8900"
                                                            className="w-full glass-input rounded-xl pl-12 pr-4 py-4 text-nobuf-text placeholder-nobuf-subtext/50 focus:outline-none focus:border-nobuf-primary transition-all text-lg tracking-wide"
                                                        />
                                                    </div>
                                                </div>
                                                <div className="flex flex-col gap-3">
                                                    <button
                                                        type="submit"
                                                        disabled={loading}
                                                        className="auth-btn-shine w-full bg-nobuf-primary text-nobuf-county-green font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition-all shadow-lg active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
                                                    >
                                                        {loading ? "Connecting..." : <>Continue <ArrowRight className="w-5 h-5" /></>}
                                                    </button>
                                                    <button type="button" onClick={() => setStep("setup")} className="text-xs text-nobuf-subtext hover:text-nobuf-text transition-colors py-2">
                                                        Back to Configuration
                                                    </button>
                                                </div>
                                            </form>
                                        ) : (
                                            <QrLoginPanel
                                                loading={loading}
                                                qrUrl={qrUrl}
                                                qrPolling={qrPolling}
                                                onRefresh={handleQrLogin}
                                                onBack={() => { setStep("setup"); setQrPolling(false); }}
                                            />
                                        )}
                                    </div>
                                </motion.div>
                            )}

                            {step === "code" && (
                                <motion.form
                                    key="code"
                                    initial={{ x: 20, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    exit={{ x: -20, opacity: 0 }}
                                    onSubmit={handleCodeSubmit}
                                    className="flex-1 flex flex-col items-center justify-center space-y-5"
                                >
                                    <h2 className="text-lg font-semibold text-nobuf-text">Enter the Code</h2>
                                    <div className="w-full max-w-sm space-y-5">
                                        <div className="space-y-2">
                                            <label className="block text-xs font-semibold text-nobuf-subtext uppercase tracking-wider">Telegram Code</label>
                                            <div className="relative">
                                                <Key className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 auth-form-icon" />
                                                <input
                                                    type="text"
                                                    value={code}
                                                    onChange={(e) => setCode(e.target.value)}
                                                    placeholder="1 2 3 4 5"
                                                    className="w-full glass-input rounded-xl pl-12 pr-4 py-4 text-nobuf-text placeholder-nobuf-subtext/50 focus:outline-none focus:border-nobuf-primary transition-all text-2xl tracking-[0.5em] font-mono text-center"
                                                />
                                            </div>
                                        </div>
                                        <div className="flex flex-col gap-3">
                                            <button
                                                type="submit"
                                                disabled={loading}
                                                className="auth-btn-shine w-full bg-nobuf-primary text-nobuf-county-green font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition-all shadow-lg active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                {loading ? "Verifying..." : "Sign In"}
                                            </button>
                                            <button type="button" onClick={() => setStep("phone")} className="text-xs text-nobuf-subtext hover:text-nobuf-text transition-colors py-2">
                                                Change Phone Number
                                            </button>
                                        </div>
                                    </div>
                                </motion.form>
                            )}

                            {step === "password" && (
                                <motion.form
                                    key="password"
                                    initial={{ x: 20, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    exit={{ x: -20, opacity: 0 }}
                                    onSubmit={handlePasswordSubmit}
                                    className="flex-1 flex flex-col items-center justify-center space-y-5"
                                >
                                    <h2 className="text-lg font-semibold text-nobuf-text">Enter Cloud Password</h2>
                                    <div className="w-full max-w-sm space-y-5">
                                        <div className="space-y-2">
                                            <label className="block text-xs font-semibold text-nobuf-subtext uppercase tracking-wider">Cloud Password</label>
                                            <div className="relative">
                                                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 auth-form-icon" />
                                                <input
                                                    type="password"
                                                    value={password}
                                                    onChange={(e) => setPassword(e.target.value)}
                                                    placeholder="Enter your password"
                                                    className="w-full glass-input rounded-xl pl-12 pr-4 py-4 text-nobuf-text placeholder-nobuf-subtext/50 focus:outline-none focus:border-nobuf-primary transition-all text-lg"
                                                    autoFocus
                                                />
                                            </div>
                                        </div>
                                        <div className="flex flex-col gap-3">
                                            <button
                                                type="submit"
                                                disabled={loading || !password}
                                                className="auth-btn-shine w-full bg-nobuf-primary text-nobuf-county-green font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition-all shadow-lg active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                {loading ? "Verifying..." : "Unlock"}
                                            </button>
                                            <button type="button" onClick={() => { setStep("code"); setPassword(""); setError(null); }} className="text-xs text-nobuf-subtext hover:text-nobuf-text transition-colors py-2">
                                                Back to Code Entry
                                            </button>
                                        </div>
                                    </div>
                                </motion.form>
                            )}
                        </>
                        )}
                    </AnimatePresence>

                    {error && (
                        <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="mt-4 p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-3"
                        >
                            <div className="w-1.5 h-1.5 rounded-full bg-red-500 mt-2 shrink-0" />
                            <p className="text-red-400 text-sm leading-snug">{error}</p>
                        </motion.div>
                    )}
                </div>

                {/* ── RIGHT PANEL ── */}
                <div className="auth-split-right p-4 md:p-8 rounded-2xl shadow-2xl overflow-y-auto">
                    <AnimatePresence mode="wait">
                        {floodWait ? (
                            <motion.div key="flood-right" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                                <FloodWaitContext />
                            </motion.div>
                        ) : (
                        <>
                            {step === "setup" && (
                                <motion.div key="setup-right" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                                    <p className="text-nobuf-subtext text-sm font-medium mb-6">
                                        Your Telegram-powered cloud drive with zero-buffer streaming
                                    </p>
                                    <SetupGuide />
                                </motion.div>
                            )}
                            {step === "phone" && (
                                <motion.div key="phone-right" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                                    <PhoneContext />
                                </motion.div>
                            )}
                            {step === "code" && (
                                <motion.div key="code-right" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                                    <CodeContext phone={phone} />
                                </motion.div>
                            )}
                            {step === "password" && (
                                <motion.div key="password-right" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                                    <PasswordContext />
                                </motion.div>
                            )}
                        </>
                        )}
                    </AnimatePresence>
                </div>
            </div>
        </div>
    );
}

/* ── Sub-components ──────────────────────────── */

function PhoneQrToggle({ loginMethod, setLoginMethod, setQrUrl, setQrPolling, setError, handleQrLogin }: {
    loginMethod: 'phone' | 'qr';
    setLoginMethod: (m: 'phone' | 'qr') => void;
    setQrUrl: (u: string | null) => void;
    setQrPolling: (p: boolean) => void;
    setError: (e: string | null) => void;
    handleQrLogin: () => void;
}) {
    return (
        <div className="flex rounded-xl overflow-hidden border border-nobuf-border">
            <button
                type="button"
                onClick={() => { setLoginMethod('phone'); setQrUrl(null); setQrPolling(false); setError(null); }}
                className={`flex-1 py-2.5 text-sm font-medium flex items-center justify-center gap-2 transition-all ${
                    loginMethod === 'phone'
                        ? 'bg-nobuf-primary/15 text-nobuf-text'
                        : 'text-nobuf-subtext hover:text-nobuf-text'
                }`}
            >
                <Phone className="w-4 h-4" /> Phone Number
            </button>
            <button
                type="button"
                onClick={() => { setLoginMethod('qr'); setError(null); handleQrLogin(); }}
                className={`flex-1 py-2.5 text-sm font-medium flex items-center justify-center gap-2 transition-all ${
                    loginMethod === 'qr'
                        ? 'bg-nobuf-primary/15 text-nobuf-text'
                        : 'text-nobuf-subtext hover:text-nobuf-text'
                }`}
            >
                <QrCode className="w-4 h-4" /> QR Code
            </button>
        </div>
    );
}

function QrLoginPanel({ loading, qrUrl, qrPolling, onRefresh, onBack }: {
    loading: boolean;
    qrUrl: string | null;
    qrPolling: boolean;
    onRefresh: () => void;
    onBack: () => void;
}) {
    return (
        <div className="flex flex-col items-center gap-5">
            {loading && !qrUrl && (
                <div className="w-52 h-52 rounded-2xl bg-nobuf-primary/5 flex items-center justify-center">
                    <div className="w-8 h-8 border-2 border-nobuf-primary border-t-transparent rounded-full animate-spin" />
                </div>
            )}
            {qrUrl && (
                <>
                    <div className="p-4 bg-white rounded-2xl shadow-xl">
                        <QRCodeSVG value={qrUrl} size={200} level="M" bgColor="#ffffff" fgColor="#013718" />
                    </div>
                    <div className="text-center space-y-1">
                        <p className="text-sm text-nobuf-text">Scan with your Telegram app</p>
                        <p className="text-xs text-nobuf-subtext">Settings &gt; Devices &gt; Link Desktop Device</p>
                    </div>
                    {qrPolling && (
                        <div className="flex items-center gap-2 text-xs text-nobuf-primary">
                            <div className="w-3 h-3 border-2 border-nobuf-primary border-t-transparent rounded-full animate-spin" />
                            Waiting for scan...
                        </div>
                    )}
                    <button type="button" onClick={onRefresh} className="text-xs text-nobuf-subtext hover:text-nobuf-text transition-colors">
                        Refresh QR Code
                    </button>
                </>
            )}
            <button type="button" onClick={onBack} className="text-xs text-nobuf-subtext hover:text-nobuf-text transition-colors py-2">
                Back to Configuration
            </button>
        </div>
    );
}
