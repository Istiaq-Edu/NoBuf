import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
    ArrowLeft, RefreshCw, Download, ExternalLink, Github, Globe, Info, Heart, Package
} from 'lucide-react';
import { getVersion, getTauriVersion } from '@tauri-apps/api/app';
import { check as checkForAppUpdate, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { toast } from 'sonner';

interface AboutPageProps {
    onClose: () => void;
}

export function AboutPage({ onClose }: AboutPageProps) {
    const [appVersion, setAppVersion] = useState('—');
    const [tauriVersion, setTauriVersion] = useState('—');
    const [updateChecking, setUpdateChecking] = useState(false);
    const [updateAvailable, setUpdateAvailable] = useState<Update | null>(null);
    const [updateDownloadProgress, setUpdateDownloadProgress] = useState<number | null>(null);
    const [updateError, setUpdateError] = useState<string | null>(null);

    // Load app version + Tauri runtime version on mount
    useEffect(() => {
        getVersion().then(v => setAppVersion(v)).catch(() => {});
        getTauriVersion().then(v => setTauriVersion(v)).catch(() => {});
    }, []);

    const handleManualUpdateCheck = async () => {
        setUpdateChecking(true);
        setUpdateError(null);
        setUpdateAvailable(null);
        setUpdateDownloadProgress(null);
        try {
            const updateInfo = await checkForAppUpdate();
            if (updateInfo) {
                setUpdateAvailable(updateInfo);
            } else {
                toast.success('You\'re running the latest version');
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to check for updates';
            setUpdateError(msg);
            toast.error(`Update check failed: ${msg}`);
        } finally {
            setUpdateChecking(false);
        }
    };

    const handleDownloadAndInstall = async () => {
        if (!updateAvailable) return;
        setUpdateDownloadProgress(0);
        let downloaded = 0;
        let contentLength = 0;
        try {
            await updateAvailable.downloadAndInstall((event) => {
                if (event.event === 'Started') {
                    const data = event.data as { contentLength?: number };
                    contentLength = data.contentLength || 0;
                } else if (event.event === 'Progress') {
                    const data = event.data as { chunkLength?: number };
                    downloaded += data.chunkLength || 0;
                    if (contentLength > 0) {
                        setUpdateDownloadProgress(Math.min(Math.round((downloaded / contentLength) * 100), 100));
                    }
                }
            });
            toast.success('Update installed — restarting...');
            await relaunch();
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to install update';
            setUpdateError(msg);
            toast.error(`Update failed: ${msg}`);
            setUpdateDownloadProgress(null);
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="settings-page"
        >
            <div className="settings-content-full">
                {/* Header with back button */}
                <div className="settings-page-header">
                    <button onClick={onClose} className="settings-back-btn">
                        <ArrowLeft className="w-5 h-5" />
                    </button>
                    <div>
                        <h2 className="settings-page-title">About</h2>
                        <p className="settings-page-subtitle">App information & updates</p>
                    </div>
                </div>

                {/* About content */}
                <div className="about-page-body">

                    {/* App identity hero */}
                    <div className="settings-card about-hero-card">
                        <div className="about-logo-wrap">
                            <div className="about-logo-badge">
                                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                    <polyline points="17 8 12 3 7 8" />
                                    <line x1="12" y1="3" x2="12" y2="15" />
                                </svg>
                            </div>
                            <div className="about-hero-text">
                                <h4 className="about-app-name">NoBuf</h4>
                                <p className="about-app-tagline">Zero-buffer video player powered by Telegram channels</p>
                            </div>
                        </div>
                        <div className="about-version-pill">
                            <span className="about-version-label">Version</span>
                            <span className="about-version-value">{appVersion}</span>
                        </div>
                    </div>

                    {/* Check for Updates */}
                    <div className="settings-card">
                        <div className="flex items-center gap-3">
                            <div className="settings-icon-box">
                                <RefreshCw className="w-5 h-5" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="settings-card-title">Check for Updates</p>
                                <p className="settings-card-desc">
                                    {updateAvailable
                                        ? `Version ${updateAvailable.version} is available`
                                        : 'Check for the latest release from GitHub'}
                                </p>
                            </div>
                            {!updateAvailable && (
                                <button
                                    disabled={updateChecking || updateDownloadProgress !== null}
                                    onClick={handleManualUpdateCheck}
                                    className="settings-action-btn"
                                >
                                    {updateChecking ? (
                                        <>
                                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                            Checking...
                                        </>
                                    ) : (
                                        <>
                                            <RefreshCw className="w-3.5 h-3.5" />
                                            Check Now
                                        </>
                                    )}
                                </button>
                            )}
                        </div>

                        {/* Update available — download + install */}
                        {updateAvailable && (
                            <div className="about-update-panel">
                                <div className="about-update-info">
                                    <span className="about-update-version">v{updateAvailable.version}</span>
                                    <span className="about-update-arrow">←</span>
                                    <span className="about-update-current">v{appVersion}</span>
                                </div>
                                {updateDownloadProgress !== null ? (
                                    <div className="about-update-progress-wrap">
                                        <div className="about-update-progress-bar">
                                            <div
                                                className="about-update-progress-fill"
                                                style={{ width: `${updateDownloadProgress}%` }}
                                            />
                                        </div>
                                        <span className="about-update-progress-pct">{updateDownloadProgress}%</span>
                                    </div>
                                ) : (
                                    <button
                                        onClick={handleDownloadAndInstall}
                                        className="about-update-btn"
                                    >
                                        <Download className="w-4 h-4" />
                                        Download &amp; Install
                                    </button>
                                )}
                            </div>
                        )}

                        {/* Error */}
                        {updateError && (
                            <p className="about-update-error">{updateError}</p>
                        )}
                    </div>

                    {/* Links */}
                    <div className="settings-card">
                        <p className="settings-card-title mb-3">Links</p>
                        <div className="about-links-grid">
                            <button
                                onClick={() => openUrl('https://github.com/Istiaq-Edu/NoBuf')}
                                className="about-link-btn"
                            >
                                <Github className="w-4 h-4" />
                                <span>Source Code</span>
                                <ExternalLink className="w-3 h-3 ml-auto opacity-50" />
                            </button>
                            <button
                                onClick={() => openUrl('https://github.com/Istiaq-Edu/NoBuf/releases')}
                                className="about-link-btn"
                            >
                                <Package className="w-4 h-4" />
                                <span>Releases</span>
                                <ExternalLink className="w-3 h-3 ml-auto opacity-50" />
                            </button>
                            <button
                                onClick={() => openUrl('https://istiaq-edu.github.io/NoBuf-Website/')}
                                className="about-link-btn"
                            >
                                <Globe className="w-4 h-4" />
                                <span>Website</span>
                                <ExternalLink className="w-3 h-3 ml-auto opacity-50" />
                            </button>
                            <button
                                onClick={() => openUrl('https://github.com/Istiaq-Edu/NoBuf/issues')}
                                className="about-link-btn"
                            >
                                <Info className="w-4 h-4" />
                                <span>Report Issue</span>
                                <ExternalLink className="w-3 h-3 ml-auto opacity-50" />
                            </button>
                        </div>
                    </div>

                    {/* Credits */}
                    <div className="settings-card about-credits-card">
                        <div className="flex items-center gap-2 justify-center">
                            <Heart className="w-4 h-4 text-nobuf-primary shrink-0" />
                            <p className="about-credits-text">
                                Built with Tauri, Rust &amp; React. Telegram channels provide unlimited free storage.
                            </p>
                        </div>
                        <p className="about-credits-sub">
                            NoBuf is open-source software. Not affiliated with Telegram.
                        </p>
                        <p className="about-credits-sub about-tauri-version">
                            Tauri runtime v{tauriVersion}
                        </p>
                    </div>

                </div>
            </div>
        </motion.div>
    );
}
