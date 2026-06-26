import { describe, it, expect, afterEach } from 'vitest';
import { sanitizeFilename } from '../utils';

// CI runs in Node where navigator doesn't exist — mock it
if (typeof globalThis.navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', {
        value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        writable: true,
        configurable: true,
    });
}

function setUA(ua: string) {
    Object.defineProperty(globalThis, 'navigator', {
        value: { userAgent: ua },
        writable: true,
        configurable: true,
    });
}

describe('sanitizeFilename', () => {
    afterEach(() => {
        setUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    });

    it('strips Windows-invalid characters on Windows', () => {
        setUA('Windows');
        expect(sanitizeFilename('file:name.txt')).toBe('filename.txt');
        expect(sanitizeFilename('file<name>.txt')).toBe('filename.txt');
        expect(sanitizeFilename('file|name?.txt')).toBe('filename.txt');
        expect(sanitizeFilename('file*name"\\')).toBe('filename');
    });

    it('strips trailing dots and spaces on Windows (NTFS ADS prevention)', () => {
        setUA('Windows');
        expect(sanitizeFilename('file.txt...')).toBe('file.txt');
        expect(sanitizeFilename('file   ')).toBe('file');
    });

    it('strips only forward slash on non-Windows', () => {
        setUA('Macintosh');
        expect(sanitizeFilename('file:name.txt')).toBe('file:name.txt');
        expect(sanitizeFilename('file/name.txt')).toBe('filename.txt');
        expect(sanitizeFilename('file<name>.txt')).toBe('file<name>.txt');
    });

    it('handles empty string', () => {
        expect(sanitizeFilename('')).toBe('');
    });

    it('handles clean filename (no change needed)', () => {
        setUA('Windows');
        expect(sanitizeFilename('normal_file.mp4')).toBe('normal_file.mp4');
    });
});
