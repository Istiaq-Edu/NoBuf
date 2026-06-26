import { createContext, useContext, useState, ReactNode, useLayoutEffect, useCallback, useEffect } from 'react';
import { CustomTheme, applyTheme, removeCustomTheme, generateThemeId } from '../theme/themeEngine';
import { BUILTIN_THEMES } from '../theme/presets';

type BaseTheme = 'light' | 'dark';

interface ThemeContextType {
    // Base light/dark toggle (used when no custom theme is active)
    theme: BaseTheme;
    toggleTheme: () => void;
    setTheme: (theme: BaseTheme) => void;
    // Full custom theme system
    customThemes: CustomTheme[];
    activeCustomThemeId: string | null;
    setActiveCustomTheme: (id: string | null) => void;
    addCustomTheme: (theme: CustomTheme) => void;
    deleteCustomTheme: (id: string) => void;
    updateCustomTheme: (id: string, updates: Partial<CustomTheme>) => void;
    // Legacy compat
    customColors: CustomTheme['palette'] | null;
    setCustomColors: (colors: CustomTheme['palette'] | null) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

// Get initial base theme synchronously to prevent flash
function getInitialTheme(): BaseTheme {
    if (typeof window !== 'undefined') {
        const saved = localStorage.getItem('nobuf-theme') as BaseTheme;
        if (saved === 'light' || saved === 'dark') return saved;
        if (window.matchMedia('(prefers-color-scheme: light)').matches) {
            return 'light';
        }
    }
    return 'dark';
}

// Get saved custom themes
function getInitialCustomThemes(): CustomTheme[] {
    if (typeof window !== 'undefined') {
        const saved = localStorage.getItem('nobuf-custom-themes');
        if (saved) {
            try {
                return JSON.parse(saved) as CustomTheme[];
            } catch {
                return [];
            }
        }
    }
    return [];
}

// Get active custom theme ID
function getInitialActiveThemeId(): string | null {
    if (typeof window !== 'undefined') {
        return localStorage.getItem('nobuf-active-theme');
    }
    return null;
}

// Apply base theme to DOM
function applyBaseTheme(theme: BaseTheme) {
    const root = document.documentElement;
    if (theme === 'light') {
        root.classList.add('light');
        root.classList.remove('dark');
    } else {
        root.classList.add('dark');
        root.classList.remove('light');
    }
}

// Apply theme immediately on script load (before React hydration)
if (typeof window !== 'undefined') {
    applyBaseTheme(getInitialTheme());
    const initialThemes = [...BUILTIN_THEMES, ...getInitialCustomThemes()];
    const activeId = getInitialActiveThemeId();
    const activeTheme = initialThemes.find(t => t.id === activeId);
    if (activeTheme) {
        applyTheme(activeTheme);
    }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [theme, setThemeState] = useState<BaseTheme>(getInitialTheme);
    const [userThemes, setUserThemes] = useState<CustomTheme[]>(getInitialCustomThemes);
    const [activeCustomThemeId, setActiveCustomThemeIdState] = useState<string | null>(getInitialActiveThemeId);

    const allThemes = [...BUILTIN_THEMES, ...userThemes];

    // Apply base theme
    useLayoutEffect(() => {
        // If a custom theme is active, it handles the dark/light class
        if (!activeCustomThemeId) {
            applyBaseTheme(theme);
            removeCustomTheme();
        }
        localStorage.setItem('nobuf-theme', theme);
    }, [theme, activeCustomThemeId]);

    // Apply custom theme when active theme changes
    useLayoutEffect(() => {
        if (activeCustomThemeId) {
            const activeTheme = allThemes.find(t => t.id === activeCustomThemeId);
            if (activeTheme) {
                applyTheme(activeTheme);
            } else {
                // Fallback: active theme was deleted externally — clear stale state
                setActiveCustomThemeIdState(null);
                removeCustomTheme();
                applyBaseTheme(theme);
            }
        } else {
            removeCustomTheme();
            applyBaseTheme(theme);
        }
        localStorage.setItem('nobuf-active-theme', activeCustomThemeId || '');
    }, [activeCustomThemeId, userThemes, theme]);

    // Persist user themes
    useEffect(() => {
        localStorage.setItem('nobuf-custom-themes', JSON.stringify(userThemes));
    }, [userThemes]);

    const toggleTheme = () => {
        setThemeState(t => t === 'dark' ? 'light' : 'dark');
        // Deactivate custom theme when toggling base
        if (activeCustomThemeId) setActiveCustomThemeIdState(null);
    };

    const setTheme = (newTheme: BaseTheme) => {
        setThemeState(newTheme);
        if (activeCustomThemeId) setActiveCustomThemeIdState(null);
    };

    const setActiveCustomTheme = (id: string | null) => {
        setActiveCustomThemeIdState(id);
    };

    const addCustomTheme = (customTheme: CustomTheme) => {
        setUserThemes(prev => [...prev, customTheme]);
    };

    const deleteCustomTheme = (id: string) => {
        setUserThemes(prev => prev.filter(t => t.id !== id));
        if (activeCustomThemeId === id) {
            setActiveCustomThemeIdState(null);
        }
    };

    const updateCustomTheme = (id: string, updates: Partial<CustomTheme>) => {
        setUserThemes(prev => prev.map(t => t.id === id ? { ...t, ...updates, id: t.id } : t));
    };

    // Legacy compat — derive customColors from active theme
    const activeTheme = allThemes.find(t => t.id === activeCustomThemeId);
    const customColors = activeTheme ? activeTheme.palette : null;
    const setCustomColors = useCallback((colors: CustomTheme['palette'] | null) => {
        if (colors) {
            // Find or create a theme with these colors
            const existing = userThemes.find(t =>
                JSON.stringify(t.palette) === JSON.stringify(colors)
            );
            if (existing) {
                setActiveCustomThemeIdState(existing.id);
            } else {
                const newTheme: CustomTheme = {
                    id: generateThemeId(),
                    name: 'Custom',
                    isDark: theme === 'dark',
                    palette: colors,
                };
                addCustomTheme(newTheme);
                setActiveCustomThemeIdState(newTheme.id);
            }
        } else {
            setActiveCustomThemeIdState(null);
        }
    }, [userThemes, theme]);

    return (
        <ThemeContext.Provider value={{
            theme, toggleTheme, setTheme,
            customThemes: allThemes,
            activeCustomThemeId,
            setActiveCustomTheme,
            addCustomTheme,
            deleteCustomTheme,
            updateCustomTheme,
            customColors,
            setCustomColors,
        }}>
            {children}
        </ThemeContext.Provider>
    );
}

export const useTheme = () => {
    const context = useContext(ThemeContext);
    if (!context) throw new Error('useTheme must be used within a ThemeProvider');
    return context;
};
