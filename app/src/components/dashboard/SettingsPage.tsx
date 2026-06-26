import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
    ArrowLeft, Upload, Download, LayoutGrid, FileText, Globe, HardDrive,
    Key, Copy, Check, RefreshCw, Trash2, RotateCcw, Film, Music,
    ImageIcon, Package, Cpu, Wifi, Network, Activity, Shield, LogOut, Palette, Sparkles, Plus
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { useSettings } from '../../context/SettingsContext';
import { useTheme } from '../../context/ThemeContext';
import { useConfirm } from '../../context/ConfirmContext';
import { CustomTheme, ThemeColorPalette, generateThemeId } from '../../theme/themeEngine';
import { getDefaultPalette } from '../../theme/presets';
import { FileCategory, ALL_FILE_CATEGORIES } from '../../utils';

interface SettingsPageProps {
    onClose: () => void;
    onLogout: () => void;
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

export function SettingsPage({ onClose, onLogout }: SettingsPageProps) {
    const { settings, updateSetting, resetSettings } = useSettings();
    const { theme: _theme, toggleTheme: _toggleTheme, customThemes, activeCustomThemeId, setActiveCustomTheme, addCustomTheme, deleteCustomTheme, updateCustomTheme } = useTheme();
    const { confirm } = useConfirm();
    const [clearing, setClearing] = useState(false);

    // Theme editor state
    const [editingThemeId, setEditingThemeId] = useState<string | null>(null);

    // Network settings state
    const [chunkSize, setChunkSize] = useState(512);
    const [keepAlive, setKeepAlive] = useState(0);
    const [prebufferLimit, setPrebufferLimit] = useState(0);
    const [downloadLimit, setDownloadLimit] = useState(0);
    const [vpnDetected, setVpnDetected] = useState<boolean | null>(null);
    const [checkingVpn, setCheckingVpn] = useState(false);
    const [networkSettingsLoaded, setNetworkSettingsLoaded] = useState(false);
    const [dcResults, setDcResults] = useState<[string, number][] | null>(null);
    const [testingDcs, setTestingDcs] = useState(false);

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

    // Load network settings on mount
    useEffect(() => {
        if (networkSettingsLoaded) return;
        invoke<{ chunk_size_kb: number; keep_alive_interval_sec: number; prebuffer_speed_limit_kb: number; download_speed_limit_kb: number }>('cmd_get_network_settings')
            .then(s => {
                setChunkSize(s.chunk_size_kb);
                setKeepAlive(s.keep_alive_interval_sec);
                setPrebufferLimit(s.prebuffer_speed_limit_kb);
                setDownloadLimit(s.download_speed_limit_kb);
                setNetworkSettingsLoaded(true);
            })
            .catch(() => setNetworkSettingsLoaded(true));
    }, [networkSettingsLoaded]);

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

                    {/* ===== Themes ===== */}
                    <div className="settings-category">
                        <div className="settings-category-header">
                            <Palette className="w-4 h-4" />
                            <h3 className="settings-category-title">Themes</h3>
                            <p className="settings-category-desc">Customize colors</p>
                        </div>
                        <div className="settings-category-body space-y-3">

                            {/* Preset themes */}
                            <div className="settings-card">
                                <div className="flex items-center gap-2 mb-3">
                                    <Palette className="w-4 h-4 text-nobuf-primary shrink-0" />
                                    <p className="settings-card-title">Presets</p>
                                </div>
                                <div className="grid grid-cols-4 gap-2">
                                    {customThemes.filter(t => t.isBuiltin).map(t => (
                                        <button
                                            key={t.id}
                                            onClick={() => {
                                                if (activeCustomThemeId === t.id) {
                                                    setActiveCustomTheme(null);
                                                    setEditingThemeId(null);
                                                } else {
                                                    setActiveCustomTheme(t.id);
                                                    setEditingThemeId(null);
                                                }
                                            }}
                                            className={`relative rounded-lg p-0.5 transition-all duration-200 ${activeCustomThemeId === t.id ? 'ring-2 ring-nobuf-primary ring-offset-1 ring-offset-nobuf-surface' : 'hover:ring-1 hover:ring-nobuf-subtext/30'}`}
                                            title={t.name}
                                        >
                                            <div className="rounded-md overflow-hidden h-10 flex">
                                                <div className="flex-1" style={{ background: t.palette.bg }} />
                                                <div className="flex-1" style={{ background: t.palette.surface }} />
                                                <div className="flex-1" style={{ background: t.palette.primary }} />
                                            </div>
                                            <p className="text-[10px] text-nobuf-subtext mt-1 truncate text-center">{t.name}</p>
                                            {activeCustomThemeId === t.id && (
                                                <div className="absolute -top-1 -right-1 w-4 h-4 bg-nobuf-primary rounded-full flex items-center justify-center">
                                                    <Check className="w-2.5 h-2.5 text-white" />
                                                </div>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Custom themes */}
                            <div className="settings-card">
                                <div className="flex items-center gap-2 mb-3">
                                    <Sparkles className="w-4 h-4 text-nobuf-primary shrink-0" />
                                    <p className="settings-card-title">Custom Themes</p>
                                </div>

                                {customThemes.filter(t => !t.isBuiltin).length > 0 && (
                                    <div className="grid grid-cols-4 gap-2 mb-2">
                                        {customThemes.filter(t => !t.isBuiltin).map(t => (
                                            <button
                                                key={t.id}
                                                onClick={() => {
                                                    if (activeCustomThemeId === t.id) {
                                                        setActiveCustomTheme(null);
                                                        setEditingThemeId(null);
                                                    } else {
                                                        setActiveCustomTheme(t.id);
                                                        setEditingThemeId(t.id);
                                                    }
                                                }}
                                                className={`relative rounded-lg p-0.5 transition-all duration-200 ${activeCustomThemeId === t.id ? 'ring-2 ring-nobuf-primary ring-offset-1 ring-offset-nobuf-surface' : 'hover:ring-1 hover:ring-nobuf-subtext/30'}`}
                                                title={t.name}
                                            >
                                                <div className="rounded-md overflow-hidden h-10 flex">
                                                    <div className="flex-1" style={{ background: t.palette.bg }} />
                                                    <div className="flex-1" style={{ background: t.palette.surface }} />
                                                    <div className="flex-1" style={{ background: t.palette.primary }} />
                                                </div>
                                                <p className="text-[10px] text-nobuf-subtext mt-1 truncate text-center">{t.name}</p>
                                                {activeCustomThemeId === t.id && (
                                                    <div className="absolute -top-1 -right-1 w-4 h-4 bg-nobuf-primary rounded-full flex items-center justify-center">
                                                        <Check className="w-2.5 h-2.5 text-white" />
                                                    </div>
                                                )}
                                            </button>
                                        ))}
                                    </div>
                                )}

                                <button
                                    onClick={() => {
                                        const id = generateThemeId();
                                        const newTheme: CustomTheme = {
                                            id,
                                            name: 'My Theme',
                                            isDark: true,
                                            palette: getDefaultPalette(true),
                                        };
                                        addCustomTheme(newTheme);
                                        setEditingThemeId(id);
                                        setActiveCustomTheme(id);
                                    }}
                                    className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border border-dashed border-nobuf-border text-nobuf-subtext hover:text-nobuf-primary hover:border-nobuf-primary/50 transition-colors text-xs"
                                >
                                    <Plus className="w-3.5 h-3.5" />
                                    Create Theme
                                </button>
                            </div>

                            {/* Theme editor — shown when a custom theme is selected for editing */}
                            {(() => {
                                const editingTheme = editingThemeId ? customThemes.find(t => t.id === editingThemeId) : null;
                                if (!editingTheme || editingTheme.isBuiltin) return null;

                                const handlePaletteChange = (key: keyof ThemeColorPalette, value: string) => {
                                    const newPalette = { ...editingTheme.palette, [key]: value };
                                    updateCustomTheme(editingTheme.id, { palette: newPalette });
                                };

                                const paletteKeys: { key: keyof ThemeColorPalette; label: string }[] = [
                                    { key: 'bg', label: 'Background' },
                                    { key: 'surface', label: 'Surface' },
                                    { key: 'primary', label: 'Primary' },
                                    { key: 'secondary', label: 'Secondary' },
                                    { key: 'text', label: 'Text' },
                                    { key: 'subtext', label: 'Subtext' },
                                    { key: 'border', label: 'Border' },
                                    { key: 'hover', label: 'Hover' },
                                ];

                                return (
                                    <div className="settings-card space-y-3">
                                        <div className="flex items-center gap-2">
                                            <p className="settings-card-title flex-1">Edit Theme</p>
                                            <button
                                                onClick={async () => {
                                                    const ok = await confirm({
                                                        title: 'Delete Theme',
                                                        message: 'Delete this custom theme?',
                                                        confirmText: 'Delete',
                                                        variant: 'danger',
                                                    });
                                                    if (ok) {
                                                        deleteCustomTheme(editingTheme.id);
                                                        setEditingThemeId(null);
                                                    }
                                                }}
                                                className="p-1.5 text-nobuf-subtext hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                                                title="Delete theme"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>

                                        {/* Theme name */}
                                        <div className="flex items-center gap-2">
                                            <label className="text-xs text-nobuf-subtext w-20 shrink-0">Name</label>
                                            <input
                                                type="text"
                                                value={editingTheme.name}
                                                onChange={e => updateCustomTheme(editingTheme.id, { name: e.target.value })}
                                                className="flex-1 px-2 py-1.5 rounded-md text-xs bg-nobuf-bg border border-nobuf-border text-nobuf-text focus:border-nobuf-primary outline-none transition"
                                                maxLength={32}
                                            />
                                        </div>

                                        {/* Dark/Light base */}
                                        <div className="flex items-center gap-2">
                                            <label className="text-xs text-nobuf-subtext w-20 shrink-0">Base</label>
                                            <div className="flex gap-1">
                                                <button
                                                    onClick={() => updateCustomTheme(editingTheme.id, { isDark: true })}
                                                    className={`px-3 py-1 rounded-md text-xs font-medium transition ${editingTheme.isDark ? 'bg-nobuf-primary text-white' : 'bg-nobuf-hover text-nobuf-subtext hover:text-nobuf-text'}`}
                                                >
                                                    Dark
                                                </button>
                                                <button
                                                    onClick={() => updateCustomTheme(editingTheme.id, { isDark: false })}
                                                    className={`px-3 py-1 rounded-md text-xs font-medium transition ${!editingTheme.isDark ? 'bg-nobuf-primary text-white' : 'bg-nobuf-hover text-nobuf-subtext hover:text-nobuf-text'}`}
                                                >
                                                    Light
                                                </button>
                                            </div>
                                        </div>

                                        {/* Color pickers */}
                                        <div className="space-y-2">
                                            {paletteKeys.map(({ key, label }) => (
                                                <div key={key} className="flex items-center gap-2">
                                                    <label className="text-xs text-nobuf-subtext w-20 shrink-0">{label}</label>
                                                    <div className="flex items-center gap-1.5 flex-1">
                                                        <input
                                                            type="color"
                                                            value={editingTheme.palette[key].startsWith('#') ? editingTheme.palette[key] : '#888888'}
                                                            onChange={e => handlePaletteChange(key, e.target.value)}
                                                            className="w-7 h-7 rounded-md border border-nobuf-border cursor-pointer p-0.5 bg-transparent shrink-0"
                                                        />
                                                        <input
                                                            type="text"
                                                            value={editingTheme.palette[key]}
                                                            onChange={e => handlePaletteChange(key, e.target.value)}
                                                            className="flex-1 px-2 py-1 rounded-md text-xs bg-nobuf-bg border border-nobuf-border text-nobuf-text focus:border-nobuf-primary outline-none transition font-mono"
                                                            maxLength={30}
                                                        />
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })()}

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

                    {/* ===== Network ===== */}
                    <div className="settings-category">
                        <div className="settings-category-header">
                            <Network className="w-4 h-4" />
                            <h3 className="settings-category-title">Network</h3>
                            <p className="settings-category-desc">Connection, chunk sizes, keep-alive, diagnostics</p>
                        </div>
                        <div className="settings-category-body space-y-3">

                            {/* Chunk Size */}
                            <div className="settings-card">
                                <div className="flex items-center gap-3">
                                    <div className="settings-icon-box">
                                        <Download className="w-5 h-5" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="settings-card-title">Download Chunk Size</p>
                                        <p className="settings-card-desc">Smaller = more stable on bad connections. Larger = faster on good ones.</p>
                                    </div>
                                    <div className="settings-toggle-group shrink-0">
                                        {([ { v: 128, l: '128' }, { v: 256, l: '256' }, { v: 512, l: '512' } ]).map(opt => (
                                            <button
                                                key={opt.v}
                                                onClick={async () => {
                                                    setChunkSize(opt.v);
                                                    try {
                                                        await invoke('cmd_set_chunk_size', { chunkSizeKb: opt.v });
                                                        await invoke('cmd_save_network_settings', {
                                                            chunkSizeKb: opt.v, keepAliveIntervalSec: keepAlive,
                                                            prebufferSpeedLimitKb: prebufferLimit, downloadSpeedLimitKb: downloadLimit
                                                        });
                                                        toast.success(`Chunk size set to ${opt.v}KB`);
                                                    } catch (err) { toast.error(`Failed: ${err}`); }
                                                }}
                                                className={`settings-toggle-option ${chunkSize === opt.v ? 'active' : ''}`}
                                            >
                                                {opt.l}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            {/* Keep-Alive */}
                            <div className="settings-card">
                                <div className="flex items-center gap-3">
                                    <div className="settings-icon-box">
                                        <Wifi className="w-5 h-5" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="settings-card-title">TCP Keep-Alive</p>
                                        <p className="settings-card-desc">Prevents disconnects on VPN/restrictive networks.</p>
                                    </div>
                                    <div className="settings-toggle-group shrink-0">
                                        {([ { v: 0, l: 'Off' }, { v: 30, l: '30s' }, { v: 60, l: '60s' }, { v: 120, l: '120s' } ]).map(opt => (
                                            <button
                                                key={opt.v}
                                                onClick={async () => {
                                                    setKeepAlive(opt.v);
                                                    try {
                                                        await invoke('cmd_set_keep_alive', { intervalSec: opt.v });
                                                        await invoke('cmd_save_network_settings', {
                                                            chunkSizeKb: chunkSize, keepAliveIntervalSec: opt.v,
                                                            prebufferSpeedLimitKb: prebufferLimit, downloadSpeedLimitKb: downloadLimit
                                                        });
                                                        toast.success(opt.v === 0 ? 'Keep-alive disabled' : `Keep-alive set to ${opt.v}s`);
                                                    } catch (err) { toast.error(`Failed: ${err}`); }
                                                }}
                                                className={`settings-toggle-option ${keepAlive === opt.v ? 'active' : ''}`}
                                            >
                                                {opt.l}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            {/* Prebuffer Speed Limit */}
                            <div className="settings-card">
                                <div className="flex items-center gap-3">
                                    <div className="settings-icon-box">
                                        <Activity className="w-5 h-5" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="settings-card-title">Streaming Speed Limit</p>
                                        <p className="settings-card-desc">KB/s limit for video prebuffering. 0 = unlimited.</p>
                                    </div>
                                    <input
                                        type="number"
                                        min={0}
                                        value={prebufferLimit}
                                        onChange={async (e) => {
                                            const val = Math.max(0, Number(e.target.value));
                                            setPrebufferLimit(val);
                                        }}
                                        onBlur={async () => {
                                            try {
                                                await invoke('cmd_set_speed_limits', { prebufferLimitKb: prebufferLimit, downloadLimitKb: downloadLimit });
                                                await invoke('cmd_save_network_settings', {
                                                    chunkSizeKb: chunkSize, keepAliveIntervalSec: keepAlive,
                                                    prebufferSpeedLimitKb: prebufferLimit, downloadSpeedLimitKb: downloadLimit
                                                });
                                                toast.success('Streaming speed limit saved');
                                            } catch (err) { toast.error(`Failed: ${err}`); }
                                        }}
                                        className="w-24 bg-nobuf-hover border border-nobuf-border rounded-lg px-3 py-1.5 text-sm text-nobuf-text focus:outline-none focus:border-nobuf-primary text-right"
                                    />
                                    <span className="text-xs text-nobuf-subtext">KB/s</span>
                                </div>
                            </div>

                            {/* Download Speed Limit */}
                            <div className="settings-card">
                                <div className="flex items-center gap-3">
                                    <div className="settings-icon-box">
                                        <Download className="w-5 h-5" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="settings-card-title">Download Speed Limit</p>
                                        <p className="settings-card-desc">KB/s limit for file downloads. 0 = unlimited.</p>
                                    </div>
                                    <input
                                        type="number"
                                        min={0}
                                        value={downloadLimit}
                                        onChange={async (e) => {
                                            const val = Math.max(0, Number(e.target.value));
                                            setDownloadLimit(val);
                                        }}
                                        onBlur={async () => {
                                            try {
                                                await invoke('cmd_set_speed_limits', { prebufferLimitKb: prebufferLimit, downloadLimitKb: downloadLimit });
                                                await invoke('cmd_save_network_settings', {
                                                    chunkSizeKb: chunkSize, keepAliveIntervalSec: keepAlive,
                                                    prebufferSpeedLimitKb: prebufferLimit, downloadSpeedLimitKb: downloadLimit
                                                });
                                                toast.success('Download speed limit saved');
                                            } catch (err) { toast.error(`Failed: ${err}`); }
                                        }}
                                        className="w-24 bg-nobuf-hover border border-nobuf-border rounded-lg px-3 py-1.5 text-sm text-nobuf-text focus:outline-none focus:border-nobuf-primary text-right"
                                    />
                                    <span className="text-xs text-nobuf-subtext">KB/s</span>
                                </div>
                            </div>

                            {/* VPN Detection */}
                            <div className="settings-card">
                                <div className="flex items-center gap-3">
                                    <div className="settings-icon-box">
                                        <Shield className="w-5 h-5" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="settings-card-title">VPN Status</p>
                                        <p className="settings-card-desc">Check if a VPN interface is active.</p>
                                    </div>
                                    <button
                                        disabled={checkingVpn}
                                        onClick={async () => {
                                            setCheckingVpn(true);
                                            try {
                                                const result = await invoke<boolean>('cmd_detect_vpn');
                                                setVpnDetected(result);
                                            } catch { setVpnDetected(null); }
                                            finally { setCheckingVpn(false); }
                                        }}
                                        className="px-3 py-1.5 text-sm bg-nobuf-hover border border-nobuf-border rounded-lg text-nobuf-text hover:bg-nobuf-hover/80 transition-colors disabled:opacity-50"
                                    >
                                        {checkingVpn ? 'Checking...' : 'Check'}
                                    </button>
                                    {vpnDetected !== null && !checkingVpn && (
                                        <span className={`text-xs font-medium ${vpnDetected ? 'text-nobuf-primary' : 'text-nobuf-subtext'}`}>
                                            {vpnDetected ? 'VPN Active' : 'No VPN'}
                                        </span>
                                    )}
                                </div>
                            </div>

                            {/* DC Latency — Test All Servers */}
                            <div className="settings-card">
                                <div className="flex items-center gap-3">
                                    <div className="settings-icon-box">
                                        <Activity className="w-5 h-5" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="settings-card-title">Telegram Server Latency</p>
                                        <p className="settings-card-desc">Test all 5 data centres to find the fastest.</p>
                                    </div>
                                    <button
                                        disabled={testingDcs}
                                        onClick={async () => {
                                            setTestingDcs(true);
                                            setDcResults(null);
                                            try {
                                                const results = await invoke<[string, number][]>('cmd_test_all_dcs');
                                                setDcResults(results);
                                                // Find fastest
                                                const fastest = results
                                                    .filter(([, ms]) => ms >= 0)
                                                    .sort(([, a], [, b]) => a - b);
                                                if (fastest.length > 0) {
                                                    toast.success(`Fastest: ${fastest[0][0]} at ${fastest[0][1]}ms`);
                                                } else {
                                                    toast.error('All DCs unreachable');
                                                }
                                            } catch { toast.error('Test failed'); }
                                            finally { setTestingDcs(false); }
                                        }}
                                        className="px-3 py-1.5 text-sm bg-nobuf-hover border border-nobuf-border rounded-lg text-nobuf-text hover:bg-nobuf-hover/80 transition-colors disabled:opacity-50"
                                    >
                                        {testingDcs ? 'Testing...' : 'Test All'}
                                    </button>
                                </div>
                                {dcResults && !testingDcs && (
                                    <div className="mt-3 space-y-1.5">
                                        {dcResults.map(([name, ms]) => {
                                            const fastest = dcResults.filter(([, m]) => m >= 0).sort(([, a], [, b]) => a - b)[0];
                                            const isFastest = fastest && fastest[0] === name && ms >= 0;
                                            return (
                                                <div key={name} className="flex items-center gap-2 text-xs">
                                                    <span className={`font-medium ${isFastest ? 'text-nobuf-primary' : 'text-nobuf-subtext'}`}>
                                                        {name}
                                                    </span>
                                                    {isFastest && <span className="text-nobuf-primary text-[10px]">★</span>}
                                                    <span className="ml-auto font-mono">
                                                        {ms >= 0 ? (
                                                            <span className={ms < 100 ? 'text-nobuf-primary' : ms < 300 ? 'text-nobuf-text' : 'text-amber-400'}>
                                                                {ms}ms
                                                            </span>
                                                        ) : (
                                                            <span className="text-red-400">Unreachable</span>
                                                        )}
                                                    </span>
                                                </div>
                                            );
                                        })}
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

                    {/* ===== Account ===== */}
                    <div className="settings-category">
                        <div className="settings-category-header">
                            <Shield className="w-4 h-4" />
                            <h3 className="settings-category-title">Account</h3>
                            <p className="settings-category-desc">Session management</p>
                        </div>
                        <div className="settings-category-body space-y-3">
                            <div className="settings-card">
                                <div className="flex items-center gap-3">
                                    <div className="settings-icon-box danger">
                                        <LogOut className="w-5 h-5" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="settings-card-title">Sign Out</p>
                                        <p className="settings-card-desc">Disconnect from Telegram and return to login screen.</p>
                                    </div>
                                    <button
                                        onClick={async () => {
                                            const ok = await confirm({
                                                title: 'Sign Out',
                                                message: 'Are you sure you want to sign out? You will need to log in again.',
                                                confirmText: 'Sign Out',
                                                variant: 'danger',
                                            });
                                            if (ok) onLogout();
                                        }}
                                        className="settings-danger-btn"
                                    >
                                        Sign Out
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
