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

/** Clamp a persisted numeric setting into range, falling back when non-finite. */
export function clampSetting(
    value: number | undefined,
    min: number,
    max: number,
    fallback: number,
): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(Math.max(value, min), max);
}

/**
 * Coerce a persisted OpenSubtitles API key to a safe string.
 *
 * The key is consumed by `.trim()` in the search panel and handed to a Rust command.
 * A hand-edited settings.json holding a number, object or null would throw on
 * `.trim()` and take the whole captions menu down with it — so a bad value becomes
 * the empty default (which the UI already handles as "no key yet").
 */
export function sanitizeApiKey(value: unknown, fallback: string): string {
    if (typeof value !== 'string') return fallback;
    // Keys are alphanumeric; stray whitespace from a copy-paste is trimmed, and a
    // value that could smuggle a header/newline is rejected outright.
    const trimmed = value.trim();
    if (!trimmed) return '';
    return /^[A-Za-z0-9]+$/.test(trimmed) ? trimmed : fallback;
}

/** Coerce a persisted language code to a valid ISO 639-1 pair, else the fallback. */
export function sanitizeLangCode(value: unknown, fallback: string): string {
    if (typeof value !== 'string') return fallback;
    const lower = value.trim().toLowerCase();
    return /^[a-z]{2}$/.test(lower) ? lower : fallback;
}

/**
 * Absolute epoch-ms when the OpenSubtitles daily quota resets.
 *
 * The API reports this as PROSE, not a timestamp — verified live:
 * `reset_time: "09 hours and 10 minutes"` (and the `message` field carries a UTC
 * wall-clock string in a different format). Storing the prose would be useless
 * across restarts, so it is converted to an absolute deadline at write time.
 *
 * Returns null when nothing parseable is found, which the caller treats as
 * "unknown" rather than "already expired" — guessing a reset time wrong in the
 * optimistic direction would re-enable download buttons that the API will reject.
 */
export function parseQuotaResetAt(resetTime: string, nowMs: number): number | null {
    if (typeof resetTime !== 'string' || !resetTime.trim()) return null;
    const hours = resetTime.match(/(\d+)\s*hour/i);
    const mins = resetTime.match(/(\d+)\s*min/i);
    if (!hours && !mins) return null;
    const h = hours ? parseInt(hours[1], 10) : 0;
    const m = mins ? parseInt(mins[1], 10) : 0;
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    const deltaMs = (h * 60 + m) * 60_000;
    // A reported window longer than a day means we misread the format; treat it as
    // unknown instead of locking the UI out for a week.
    if (deltaMs <= 0 || deltaMs > 25 * 60 * 60_000) return null;
    return nowMs + deltaMs;
}

/**
 * The quota to display, or null when it should no longer be trusted.
 *
 * Quota is per-day, so a value persisted from yesterday must NOT keep the download
 * buttons disabled — past its reset it is dropped and the UI goes back to "unknown"
 * until the next download reports a fresh number.
 */
export function liveQuota(
    stored: { remaining: number; resetAtMs: number } | null | undefined,
    nowMs: number,
): { remaining: number; resetAtMs: number } | null {
    if (!stored || typeof stored !== 'object') return null;
    const { remaining, resetAtMs } = stored as { remaining: unknown; resetAtMs: unknown };
    if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return null;
    if (typeof resetAtMs !== 'number' || !Number.isFinite(resetAtMs)) return null;
    if (nowMs >= resetAtMs) return null; // expired → unknown, not "0 left"
    return { remaining: Math.max(0, Math.floor(remaining)), resetAtMs };
}

/** Human "in 3h 20m" style remaining-time label for a reset deadline. */
export function formatResetIn(resetAtMs: number, nowMs: number): string {
    const ms = resetAtMs - nowMs;
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const totalMin = Math.ceil(ms / 60_000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    return `${m}m`;
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
    playerShowPinButton: boolean;   // show pin button on control bar; when off, controls never auto-hide
    playerSettingsWidth: number;    // px width of the video settings side panel (resizable + persisted)
    playerSubtitleFontScale: number;   // subtitle size multiplier, 0.5–3.0 (1 = 5% of picture height)
    playerSubtitleOffsetPct: number;   // subtitle vertical offset, -40–40 (% of picture height; + up, − down)
    openSubtitlesApiKey: string;       // user's own OpenSubtitles.com API key (free signup); never bundled
    openSubtitlesLanguage: string;     // preferred subtitle language for online search (ISO 639-1)
    openSubtitlesQuota: { remaining: number; resetAtMs: number } | null; // last reported daily download quota (free tier = 5/day)
    playerBarLayout: { left: string[]; right: string[]; tray: string[] }; // customizable control-bar chip placement (incl. '__tray__' token for the ⋯ trigger)
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
    playerShowPinButton: false,
    playerSettingsWidth: 336,
    playerSubtitleFontScale: 1,
    playerSubtitleOffsetPct: 0,
    openSubtitlesApiKey: '',
    openSubtitlesLanguage: 'en',
    openSubtitlesQuota: null,
    playerBarLayout: { left: ['skipBack', 'skipFwd'], right: ['captions', 'speed', 'download', 'settings', 'pin', 'fullscreen', '__tray__'], tray: ['loop', 'pip'] },
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
                    // Never restore playerSpeed from disk: each video starts at 1x
                    delete cleaned.playerSpeed;
                    // Subtitle size/position are numeric ranges consumed directly by
                    // the overlay's inline styles. A corrupt or out-of-range stored
                    // value must not reach it: a NaN px style is dropped silently by
                    // CSSOM, which renders no subtitles at all with no error.
                    cleaned.playerSubtitleFontScale = clampSetting(
                        cleaned.playerSubtitleFontScale, 0.5, 3, defaultSettings.playerSubtitleFontScale);
                    cleaned.playerSubtitleOffsetPct = clampSetting(
                        cleaned.playerSubtitleOffsetPct, -40, 40, defaultSettings.playerSubtitleOffsetPct);
                    // The API key and language are STRINGS consumed by `.trim()` in the
                    // search panel and passed to a Rust command. A non-string from a
                    // hand-edited settings.json would throw on `.trim()` and take the
                    // whole captions menu down, so coerce rather than trust.
                    cleaned.openSubtitlesApiKey = sanitizeApiKey(
                        cleaned.openSubtitlesApiKey, defaultSettings.openSubtitlesApiKey);
                    cleaned.openSubtitlesLanguage = sanitizeLangCode(
                        cleaned.openSubtitlesLanguage, defaultSettings.openSubtitlesLanguage);
                    // A corrupt or already-expired quota must not keep the download
                    // buttons disabled: liveQuota returns null, i.e. "unknown".
                    cleaned.openSubtitlesQuota = liveQuota(cleaned.openSubtitlesQuota, Date.now());
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
            // playerSpeed is a per-session setting, not persisted across app launches
            const { playerSpeed: _, ...toPersist } = next;
            await store.set('settings', toPersist);
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
