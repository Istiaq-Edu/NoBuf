import { describe, it, expect } from 'vitest';
import { sanitizeFilename } from '../utils';

describe('sanitizeFilename', () => {
    it('strips Windows-invalid characters on Windows', () => {
        // Mock Windows navigator
        const originalUA = navigator.userAgent;
        Object.defineProperty(navigator, 'userAgent', { value: 'Windows', configurable: true });
        expect(sanitizeFilename('file:name.txt')).toBe('filename.txt');
        expect(sanitizeFilename('file<name>.txt')).toBe('filename.txt');
        expect(sanitizeFilename('file|name?.txt')).toBe('filename.txt');
        expect(sanitizeFilename('file*name"\\/')).toBe('filename');
        Object.defineProperty(navigator, 'userAgent', { value: originalUA, configurable: true });
    });

    it('strips trailing dots and spaces on Windows (NTFS ADS prevention)', () => {
        Object.defineProperty(navigator, 'userAgent', { value: 'Windows', configurable: true });
        expect(sanitizeFilename('file.txt...')).toBe('file.txt');
        expect(sanitizeFilename('file   ')).toBe('file');
        Object.defineProperty(navigator, 'userAgent', { value: '', configurable: true });
    });

    it('strips only forward slash on non-Windows', () => {
        Object.defineProperty(navigator, 'userAgent', { value: 'Macintosh', configurable: true });
        expect(sanitizeFilename('file:name.txt')).toBe('file:name.txt');
        expect(sanitizeFilename('file/name.txt')).toBe('filename.txt');
        expect(sanitizeFilename('file<name>.txt')).toBe('file<name>.txt');
    });

    it('handles empty string', () => {
        expect(sanitizeFilename('')).toBe('');
    });

    it('handles clean filename (no change needed)', () => {
        Object.defineProperty(navigator, 'userAgent', { value: 'Windows', configurable: true });
        expect(sanitizeFilename('normal_file.mp4')).toBe('normal_file.mp4');
        Object.defineProperty(navigator, 'userAgent', { value: '', configurable: true });
    });
});
