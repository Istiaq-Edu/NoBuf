import { CustomTheme } from './themeEngine';

/** Built-in theme presets. Users cannot delete these. */
export const BUILTIN_THEMES: CustomTheme[] = [
    // NoBuf Default Dark (our existing green theme)
    {
        id: 'nobuf-dark',
        name: 'NoBuf Dark',
        isDark: true,
        isBuiltin: true,
        palette: {
            bg: '#013718',
            surface: '#0a5730',
            primary: '#1dfc9f',
            secondary: '#40a57f',
            text: '#ffffff',
            subtext: '#a8fadf',
            border: 'rgba(29, 252, 159, 0.12)',
            hover: 'rgba(29, 252, 159, 0.06)',
        },
    },
    // NoBuf Default Light
    {
        id: 'nobuf-light',
        name: 'NoBuf Light',
        isDark: false,
        isBuiltin: true,
        palette: {
            bg: '#f0faf5',
            surface: '#ffffff',
            primary: '#0a5730',
            secondary: '#40a57f',
            text: '#013718',
            subtext: '#40a57f',
            border: 'rgba(10, 87, 48, 0.1)',
            hover: 'rgba(10, 87, 48, 0.05)',
        },
    },
    // Charcoal
    {
        id: 'charcoal',
        name: 'Charcoal',
        isDark: true,
        isBuiltin: true,
        palette: {
            bg: '#1e1e2e',
            surface: '#282838',
            primary: '#6c63ff',
            secondary: '#a78bfa',
            text: '#e4e4ef',
            subtext: '#8888a8',
            border: 'rgba(255, 255, 255, 0.08)',
            hover: 'rgba(255, 255, 255, 0.04)',
        },
    },
    // Nord
    {
        id: 'nord',
        name: 'Nord',
        isDark: true,
        isBuiltin: true,
        palette: {
            bg: '#2e3440',
            surface: '#3b4252',
            primary: '#88c0d0',
            secondary: '#81a1c1',
            text: '#eceff4',
            subtext: '#a3b1c6',
            border: 'rgba(255, 255, 255, 0.08)',
            hover: 'rgba(255, 255, 255, 0.04)',
        },
    },
    // Monokai
    {
        id: 'monokai',
        name: 'Monokai',
        isDark: true,
        isBuiltin: true,
        palette: {
            bg: '#272822',
            surface: '#2f302a',
            primary: '#a6e22e',
            secondary: '#66d9ef',
            text: '#f8f8f2',
            subtext: '#90908a',
            border: 'rgba(255, 255, 255, 0.08)',
            hover: 'rgba(255, 255, 255, 0.04)',
        },
    },
    // Cyber Teal
    {
        id: 'cyber-teal',
        name: 'Cyber Teal',
        isDark: true,
        isBuiltin: true,
        palette: {
            bg: '#0a1628',
            surface: '#112240',
            primary: '#00e5bf',
            secondary: '#00b4d8',
            text: '#e0f7f4',
            subtext: '#6faaaf',
            border: 'rgba(0, 229, 191, 0.12)',
            hover: 'rgba(0, 229, 191, 0.06)',
        },
    },
    // Solarized Light
    {
        id: 'solarized-light',
        name: 'Solarized Light',
        isDark: false,
        isBuiltin: true,
        palette: {
            bg: '#fdf6e3',
            surface: '#eee8d5',
            primary: '#b58900',
            secondary: '#268bd2',
            text: '#073642',
            subtext: '#586e75',
            border: 'rgba(0, 0, 0, 0.1)',
            hover: 'rgba(0, 0, 0, 0.04)',
        },
    },
];

/** Default palette values to seed a new custom theme. */
export function getDefaultPalette(isDark: boolean) {
    const base = isDark
        ? BUILTIN_THEMES.find(t => t.id === 'nobuf-dark')!
        : BUILTIN_THEMES.find(t => t.id === 'nobuf-light')!;
    return { ...base.palette };
}
