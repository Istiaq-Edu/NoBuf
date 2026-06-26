// ── Theme Engine ────────────────────────────────────────────────────
// Core types and runtime utilities for the custom theme system.

export interface ThemeColorPalette {
    bg: string;
    surface: string;
    primary: string;
    secondary: string;
    text: string;
    subtext: string;
    border: string;
    hover: string;
}

export interface CustomTheme {
    id: string;
    name: string;
    isDark: boolean;
    palette: ThemeColorPalette;
    isBuiltin?: boolean;
}

const STYLE_ID = 'dynamic-theme';

/**
 * Inject a `<style>` block that overrides the @theme CSS variables,
 * and toggle the .dark/.light class on <html>.
 */
export function applyTheme(theme: CustomTheme): void {
    const root = document.documentElement;

    // Toggle dark/light class
    if (theme.isDark) {
        root.classList.add('dark');
        root.classList.remove('light');
    } else {
        root.classList.add('light');
        root.classList.remove('dark');
    }

    // Build CSS variable overrides — map to --color-nobuf-* prefix
    const p = theme.palette;
    const css = `:root {
  --color-nobuf-bg: ${p.bg};
  --color-nobuf-surface: ${p.surface};
  --color-nobuf-primary: ${p.primary};
  --color-nobuf-secondary: ${p.secondary};
  --color-nobuf-text: ${p.text};
  --color-nobuf-subtext: ${p.subtext};
  --color-nobuf-border: ${p.border};
  --color-nobuf-hover: ${p.hover};
  --color-nobuf-glass-bg: ${theme.isDark ? p.surface : '#ffffff'};
  --color-nobuf-glass-border: ${theme.isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'};
}`;

    // Replace or create the style element
    let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!el) {
        el = document.createElement('style');
        el.id = STYLE_ID;
        document.head.appendChild(el);
    }
    el.textContent = css;
}

/**
 * Remove the injected style block so the base @theme values take effect.
 */
export function removeCustomTheme(): void {
    const el = document.getElementById(STYLE_ID);
    if (el) el.remove();
}

/** Generate a unique ID for user-created themes. */
export function generateThemeId(): string {
    return `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
