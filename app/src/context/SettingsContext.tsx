import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { load } from '@tauri-apps/plugin-store';
import { invoke } from '@tauri-apps/api/core';
import { FileCategory } from '../utils';

export type GridDensity = 'compact' | 'default' | 'spacious';
export type SortField = 'name' | 'size' | 'date';
export type SortDirection = 'asc' | 'desc';

export type VideoFit = 'original' | 'contain' | 'fill';
export type AutoHideDelay = 3 | 5 | 10 | 0;
export type SkipDuration = 5 | 10 | 15 | 30;

/** Speed limit presets in KB/s. 0 = unlimited. */
export type SpeedLimitPreset = 0 | 256 | 512 | 1024 | 2048 | 5120 | 10240 | 20480;

/** Speed limit value: either a preset or a custom KB/s value. 0 = unlimited. */
export type SpeedLimitValue = number; // KB/s, 0 = unlimited

/** Preset speed limit options in KB/s with display labels */
export const SPEED_LIMIT_PRESETS: { value: SpeedLimitValue; label: string }[] = [
    { value: 0, label: '∞' },
    { value: 256, label: '256 KB/s' },
    { value: 512, label: '512 KB/s' },
    { value: 1024, label: '1 MB/s' },
    { value: 2048, label: '2 MB/s' },
    { value: 5120, label: '5 MB/s' },
    { value: 10240, label: '10 MB/s' },
    { value: 20480, label: '20 MB/s' },
];

/** Format a speed limit value (KB/s) for display */
export function formatSpeedLimit(kbPerSec: SpeedLimitValue): string {
    if (kbPerSec === 0) return '∞';
    if (kbPerSec >= 1024) return `${(kbPerSec / 1024).toFixed(kbPerSec % 1024 === 0 ? 0 : 1)} MB/s`;
    return `${kbPerSec} KB/s`;
}

/** Format a speed limit for the compact indicator (e.g. "↓2M" or "↓512K") */
export function formatSpeedLimitCompact(kbPerSec: SpeedLimitValue): string {
    if (kbPerSec === 0) return '';
    if (kbPerSec >= 1024) {
        const mb = kbPerSec / 1024;
        return `↓${mb % 1 === 0 ? mb : mb.toFixed(1)}M`;
    }
    return `↓${kbPerSec}K`;
}

export interface Settings {
    viewMode: 'grid' | 'list';
    autoUpdate: boolean;
    maxConcurrentUploads: number;
    maxConcurrentDownloads: number;
    gridDensity: GridDensity;
    sortField: SortField;
    sortDirection: SortDirection;
    fileFilter: FileCategory[];
    playerSpeed: number;
    playerSkipForward: SkipDuration;
    playerSkipBackward: SkipDuration;
    playerVideoFit: VideoFit;
    playerAutoHideDelay: AutoHideDelay;
    prebufferSpeedLimit: SpeedLimitValue;  // KB/s, 0 = unlimited
    downloadSpeedLimit: SpeedLimitValue;   // KB/s, 0 = unlimited
}

const defaultSettings: Settings = {
    viewMode: 'grid',
    autoUpdate: true,
    maxConcurrentUploads: 6,
    maxConcurrentDownloads: 6,
    gridDensity: 'default',
    sortField: 'name',
    sortDirection: 'asc',
    fileFilter: ['videos'],
    playerSpeed: 1,
    playerSkipForward: 5,
    playerSkipBackward: 5,
    playerVideoFit: 'contain',
    playerAutoHideDelay: 3,
    prebufferSpeedLimit: 0,
    downloadSpeedLimit: 0,
};

interface SettingsContextType {
    settings: Settings;
    updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
    resetSettings: () => void;
    isLoaded: boolean;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
    const [settings, setSettings] = useState<Settings>(defaultSettings);
    const [isLoaded, setIsLoaded] = useState(false);

    // Load settings from Tauri store on mount
    useEffect(() => {
        const loadSettings = async () => {
            try {
                const store = await load('settings.json');
                const saved = await store.get<Settings>('settings');
                if (saved) {
                    // Filter out undefined values so defaults aren't overridden
                    const cleaned = Object.fromEntries(
                        Object.entries(saved).filter(([_, v]) => v !== undefined)
                    ) as Partial<Settings>;
                    setSettings({ ...defaultSettings, ...cleaned });
                }
            } catch {
                // Store not available or first run — use defaults
            } finally {
                setIsLoaded(true);
            }
        };
        loadSettings();
    }, []);

    const persistSettings = useCallback(async (next: Settings) => {
        try {
            const store = await load('settings.json');
            await store.set('settings', next);
            await store.save();
        } catch {
            // best-effort persistence
        }
    }, []);

    const updateSetting = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
        setSettings(prev => {
            const next = { ...prev, [key]: value };
            persistSettings(next);
            // Sync speed limits to backend whenever they change
            if (key === 'prebufferSpeedLimit' || key === 'downloadSpeedLimit') {
                // console.log(`[THROTTLE-DBG][FE] updateSetting: key=${key}, value=${value}, prebuffer=${next.prebufferSpeedLimit} KB/s, download=${next.downloadSpeedLimit} KB/s → invoking cmd_set_speed_limits`);
                invoke('cmd_set_speed_limits', {
                    prebufferLimitKb: next.prebufferSpeedLimit,
                    downloadLimitKb: next.downloadSpeedLimit,
                }).then(() => {/* console.log(`[THROTTLE-DBG][FE] cmd_set_speed_limits invoke SUCCESS`) */})
                .catch(e => console.error(`cmd_set_speed_limits invoke FAILED:`, e));
            }
            return next;
        });
    }, [persistSettings]);

    // Sync speed limits to backend on initial load (app startup)
    useEffect(() => {
        if (isLoaded) {
            // console.log(`[THROTTLE-DBG][FE] Startup sync: prebuffer=${settings.prebufferSpeedLimit} KB/s, download=${settings.downloadSpeedLimit} KB/s → invoking cmd_set_speed_limits`);
            invoke('cmd_set_speed_limits', {
                prebufferLimitKb: settings.prebufferSpeedLimit,
                downloadLimitKb: settings.downloadSpeedLimit,
            }).then(() => {/* console.log(`[THROTTLE-DBG][FE] Startup cmd_set_speed_limits SUCCESS`) */})
            .catch(e => console.error(`Startup cmd_set_speed_limits FAILED:`, e));
        }
    }, [isLoaded]);

    const resetSettings = useCallback(() => {
        setSettings(defaultSettings);
        persistSettings(defaultSettings);
    }, [persistSettings]);

    return (
        <SettingsContext.Provider value={{ settings, updateSetting, resetSettings, isLoaded }}>
            {children}
        </SettingsContext.Provider>
    );
}

export const useSettings = () => {
    const context = useContext(SettingsContext);
    if (!context) throw new Error('useSettings must be used within a SettingsProvider');
    return context;
};
