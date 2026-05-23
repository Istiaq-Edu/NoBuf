import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
    ArrowLeft, Upload, Download, LayoutGrid, FileText, Globe, HardDrive,
    Key, Copy, Check, RefreshCw, Trash2, RotateCcw, Film, Music,
    ImageIcon, Package, Cpu
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { useSettings } from '../../context/SettingsContext';
import { useConfirm } from '../../context/ConfirmContext';
import { FileCategory, ALL_FILE_CATEGORIES } from '../../utils';

interface SettingsPageProps {
    onClose: () => void;
}

interface ApiSettings {
    enabled: boolean;
    port: number;
    key_set: boolean;
    running: boolean;
}

const CATEGORY_META: Record<FileCategory, { label: string; icon: typeof Film; color: string }> = {
    videos:     { label: 'Videos',     icon: Film,      color: 'bg-nobuf-ocean-green' },
    audio:      { label: 'Audio',      icon: Music,     color: 'bg-purple-500' },
    images:     { label: 'Images',     icon: ImageIcon, color: 'bg-pink-500' },
    documents:  { label: 'Documents',  icon: FileText,  color: 'bg-amber-500' },
    misc:       { label: 'Misc',       icon: Package,   color: 'bg-gray-500' },
};

export function SettingsPage({ onClose }: SettingsPageProps) {
    const { settings, updateSetting, resetSettings } = useSettings();
    const { confirm } = useConfirm();
    const [clearing, setClearing] = useState(false);

    // API settings state
    const [apiSettings, setApiSettings] = useState<ApiSettings>({ enabled: false, port: 8550, key_set: false, running: false });
    const [apiPort, setApiPort] = useState('8550');
    const [apiLoading, setApiLoading] = useState(false);
    const [generatedKey, setGeneratedKey] = useState<string | null>(null);
    const [keyCopied, setKeyCopied] = useState(false);

    const toggleCategory = useCallback((cat: FileCategory) => {
        const current = settings.fileFilter;
        const next = current.includes(cat)
            ? current.filter(c => c !== cat)
            : [...current, cat];
        updateSetting('fileFilter', next);
    }, [settings.fileFilter, updateSetting]);

    const fetchApiSettings = useCallback(async () => {
        try {
            const result = await invoke<ApiSettings>('cmd_get_api_settings');
            setApiSettings(result);
            setApiPort(result.port.toString());
        } catch {
            // API settings not available
        }
    }, []);

    useEffect(() => {
        fetchApiSettings();
        setGeneratedKey(null);
        setKeyCopied(false);
    }, [fetchApiSettings]);

    useEffect(() => {
        if (!apiSettings.enabled) return;
        const interval = setInterval(fetchApiSettings, 3000);
        return () => clearInterval(interval);
    }, [apiSettings.enabled, fetchApiSettings]);

    const handleApiToggle = async () => {
        setApiLoading(true);
        try {
            const port = parseInt(apiPort, 10);
            if (isNaN(port) || port < 1024 || port > 65535) {
                toast.error('Port must be between 1024 and 65535');
                setApiLoading(false);
                return;
            }
            const result = await invoke<ApiSettings>('cmd_update_api_settings', {
                enabled: !apiSettings.enabled,
                port,
            });
            setApiSettings(result);
            toast.success(result.enabled ? 'API server started' : 'API server stopped');
        } catch (e) {
            toast.error(`Failed to update API: ${e}`);
        } finally {
            setApiLoading(false);
        }
    };

    const handlePortApply = async () => {
        const port = parseInt(apiPort, 10);
        if (isNaN(port) || port < 1024 || port > 65535) {
            toast.error('Port must be between 1024 and 65535');
            return;
        }
        if (port === apiSettings.port) return;
        setApiLoading(true);
        try {
            const result = await invoke<ApiSettings>('cmd_update_api_settings', {
                enabled: apiSettings.enabled,
                port,
            });
            setApiSettings(result);
            toast.success(`API port updated to ${port}`);
        } catch (e) {
            toast.error(`Failed to update port: ${e}`);
        } finally {
            setApiLoading(false);
        }
    };

    const handleGenerateKey = async () => {
        const ok = await confirm({
            title: 'Generate API Key',
            message: apiSettings.key_set
                ? 'This will revoke your current API key and generate a new one. Any existing integrations will stop working.'
                : 'Generate a new API key for authenticating REST API requests.',
            confirmText: apiSettings.key_set ? 'Regenerate' : 'Generate',
            variant: apiSettings.key_set ? 'danger' : 'info',
        });
        if (!ok) return;
        try {
            const key = await invoke<string>('cmd_regenerate_api_key');
            setGeneratedKey(key);
            setKeyCopied(false);
            setApiSettings(prev => ({ ...prev, key_set: true }));
            toast.success('API key generated');
        } catch (e) {
            toast.error(`Failed to generate key: ${e}`);
        }
    };

    const handleCopyKey = async () => {
        if (!generatedKey) return;
        try {
            await navigator.clipboard.writeText(generatedKey);
            setKeyCopied(true);
            setTimeout(() => setKeyCopied(false), 2000);
        } catch {
            toast.error('Failed to copy to clipboard');
        }
    };

    // Number stepper component
    const Stepper = ({ label, description, icon: StepperIcon, value, min, max, settingKey }: {
        label: string; description: string; icon: typeof Upload;
        value: number; min: number; max: number;
        settingKey: 'maxConcurrentUploads' | 'maxConcurrentDownloads';
    }) => (
        <div className="settings-card">
            <div className="flex items-center gap-3">
                <div className="settings-icon-box">
                    <StepperIcon className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                    <p className="settings-card-title">{label}</p>
                    <p className="settings-card-desc">{description}</p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => updateSetting(settingKey, Math.max(min, value - 1))}
                        className="stepper-btn"
                    >
                        <span className="text-sm font-semibold">-</span>
                    </button>
                    <span className="stepper-value">{value}</span>
                    <button
                        onClick={() => updateSetting(settingKey, Math.min(max, value + 1))}
                        className="stepper-btn"
                    >
                        <span className="text-sm font-semibold">+</span>
                    </button>
                </div>
            </div>
        </div>
    );

    return (
        <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="settings-page"
        >
            {/* Scrollable single-page content */}
            <div className="settings-content-full">
                {/* Header with back button */}
                <div className="settings-page-header">
                    <button onClick={onClose} className="settings-back-btn">
                        <ArrowLeft className="w-5 h-5" />
                    </button>
                    <div>
                        <h2 className="settings-page-title">Settings</h2>
                        <p className="settings-page-subtitle">Configure your preferences</p>
                    </div>
                    <div className="ml-auto">
                        <button onClick={resetSettings} className="settings-reset-btn-inline">
                            <RotateCcw className="w-3.5 h-3.5" />
                            Reset All
                        </button>
                    </div>
                </div>

                {/* All settings grouped by category — single scrollable page */}
                <div className="settings-page-body">

                    {/* ===== Transfers ===== */}
                    <div className="settings-category">
                        <div className="settings-category-header">
                            <Upload className="w-4 h-4" />
                            <h3 className="settings-category-title">Transfers</h3>
                            <p className="settings-category-desc">Control upload and download concurrency</p>
                        </div>
                        <div className="settings-category-body space-y-3">
                            <Stepper
                                label="Concurrent Uploads"
                                description="Maximum parallel upload tasks"
                                icon={Upload}
                                value={settings.maxConcurrentUploads}
                                min={1}
                                max={10}
                                settingKey="maxConcurrentUploads"
                            />
                            <Stepper
                                label="Concurrent Downloads"
                                description="Maximum parallel download tasks"
                                icon={Download}
                                value={settings.maxConcurrentDownloads}
                                min={1}
                                max={10}
                                settingKey="maxConcurrentDownloads"
                            />
                        </div>
                    </div>

                    {/* ===== Appearance ===== */}
                    <div className="settings-category">
                        <div className="settings-category-header">
                            <LayoutGrid className="w-4 h-4" />
                            <h3 className="settings-category-title">Appearance</h3>
                            <p className="settings-category-desc">Customize grid layout and density</p>
                        </div>
                        <div className="settings-category-body space-y-3">
                            <div className="settings-card">
                                <div className="flex items-center gap-3">
                                    <div className="settings-icon-box">
                                        <LayoutGrid className="w-5 h-5" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="settings-card-title">Grid Density</p>
                                        <p className="settings-card-desc">Adjust how many files appear per row</p>
                                    </div>
                                </div>
                                <div className="settings-toggle-group mt-3">
                                    {([
                                        { value: 'compact' as const, label: 'Compact' },
                                        { value: 'default' as const, label: 'Default' },
                                        { value: 'spacious' as const, label: 'Spacious' },
                                    ]).map(option => (
                                        <button
                                            key={option.value}
                                            onClick={() => updateSetting('gridDensity', option.value)}
                                            className={`settings-toggle-option ${settings.gridDensity === option.value ? 'active' : ''}`}
                                        >
                                            {option.label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* ===== File Filters ===== */}
                    <div className="settings-category">
                        <div className="settings-category-header">
                            <FileText className="w-4 h-4" />
                            <h3 className="settings-category-title">File Filters</h3>
                            <p className="settings-category-desc">Select which file types to display</p>
                        </div>
                        <div className="settings-category-body space-y-3">
                            <div className="settings-card">
                                <p className="settings-card-title mb-1">Show Categories</p>
                                <p className="settings-card-desc mb-4">
                                    Toggle categories to filter the file view. Show all when none are selected.
                                </p>
                                <div className="flex flex-wrap gap-2.5">
                                    {ALL_FILE_CATEGORIES.map(cat => {
                                        const meta = CATEGORY_META[cat];
                                        const Icon = meta.icon;
                                        const isActive = settings.fileFilter.includes(cat);
                                        return (
                                            <button
                                                key={cat}
                                                onClick={() => toggleCategory(cat)}
                                                className={`settings-filter-chip ${isActive ? 'active' : ''}`}
                                            >
                                                <span className={`settings-filter-dot ${isActive ? meta.color : 'bg-nobuf-subtext/30'}`} />
                                                <Icon className="w-3.5 h-3.5" />
                                                {meta.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* ===== REST API ===== */}
                    <div className="settings-category">
                        <div className="settings-category-header">
                            <Globe className="w-4 h-4" />
                            <h3 className="settings-category-title">REST API</h3>
                            <p className="settings-category-desc">Local HTTP API for programmatic access</p>
                        </div>
                        <div className="settings-category-body space-y-3">
                            {/* Enable toggle */}
                            <div className="settings-card">
                                <div className="flex items-center gap-3">
                                    <div className={`settings-status-dot ${apiSettings.running ? 'running' : 'stopped'}`} />
                                    <div className="flex-1 min-w-0">
                                        <p className="settings-card-title">API Server</p>
                                        <p className="settings-card-desc">
                                            {apiSettings.running
                                                ? `Running on port ${apiSettings.port}`
                                                : 'Start a localhost-only HTTP server'}
                                        </p>
                                    </div>
                                    <button
                                        onClick={handleApiToggle}
                                        disabled={apiLoading}
                                        className={`settings-toggle-switch ${apiSettings.enabled ? 'on' : 'off'}`}
                                    >
                                        <span className="settings-toggle-knob" />
                                    </button>
                                </div>
                            </div>

                            {/* Port */}
                            <div className="settings-card">
                                <div className="flex items-center gap-3">
                                    <div className="settings-icon-box">
                                        <Cpu className="w-5 h-5" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="settings-card-title">Port</p>
                                        <p className="settings-card-desc">Range: 1024 - 65535</p>
                                    </div>
                                    <input
                                        type="number"
                                        min="1024"
                                        max="65535"
                                        value={apiPort}
                                        onChange={e => setApiPort(e.target.value)}
                                        onBlur={handlePortApply}
                                        onKeyDown={e => { if (e.key === 'Enter') handlePortApply(); }}
                                        className="settings-input-small"
                                    />
                                </div>
                            </div>

                            {/* API Key */}
                            <div className="settings-card">
                                <div className="flex items-center gap-3">
                                    <div className="settings-icon-box">
                                        <Key className="w-5 h-5" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="settings-card-title">API Key</p>
                                        <p className="settings-card-desc">
                                            {apiSettings.key_set ? 'Key configured — secure' : 'No key set — unauthenticated'}
                                        </p>
                                    </div>
                                    <button
                                        onClick={handleGenerateKey}
                                        className="settings-action-btn"
                                    >
                                        <RefreshCw className="w-3.5 h-3.5" />
                                        {apiSettings.key_set ? 'Regenerate' : 'Generate'}
                                    </button>
                                </div>

                                {generatedKey && (
                                    <div className="settings-key-reveal">
                                        <p className="settings-key-warning">
                                            Copy now — this key will not be shown again
                                        </p>
                                        <div className="flex items-center gap-2">
                                            <code className="settings-key-code">
                                                {generatedKey}
                                            </code>
                                            <button
                                                onClick={handleCopyKey}
                                                className="settings-key-copy-btn"
                                                title="Copy to clipboard"
                                            >
                                                {keyCopied ? <Check className="w-4 h-4 text-nobuf-primary" /> : <Copy className="w-4 h-4" />}
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* ===== Storage ===== */}
                    <div className="settings-category">
                        <div className="settings-category-header">
                            <HardDrive className="w-4 h-4" />
                            <h3 className="settings-category-title">Storage</h3>
                            <p className="settings-category-desc">Manage local cache and data</p>
                        </div>
                        <div className="settings-category-body space-y-3">
                            <div className="settings-card">
                                <div className="flex items-center gap-3">
                                    <div className="settings-icon-box danger">
                                        <Trash2 className="w-5 h-5" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="settings-card-title">Clear Local Cache</p>
                                        <p className="settings-card-desc">Remove cached previews and temp files. Uploaded files on Telegram are not affected.</p>
                                    </div>
                                    <button
                                        disabled={clearing}
                                        onClick={async () => {
                                            const ok = await confirm({
                                                title: 'Clear Cache',
                                                message: 'This will remove all cached previews and temporary files. Your uploaded files on Telegram are not affected.',
                                                confirmText: 'Clear',
                                                variant: 'danger',
                                            });
                                            if (!ok) return;
                                            setClearing(true);
                                            try {
                                                await invoke('cmd_clean_cache');
                                                toast.success('Cache cleared successfully');
                                            } catch {
                                                toast.error('Failed to clear cache');
                                            } finally {
                                                setClearing(false);
                                            }
                                        }}
                                        className="settings-danger-btn"
                                    >
                                        {clearing ? 'Clearing...' : 'Clear'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </motion.div>
    );
}
