import { describe, it, expect } from 'vitest';
import { isDropStreamItem } from '../hooks/useFileUpload';

// Truth table for the marker predicate. processItem/cancelAll/retryItem all
// route on this — a regression sends garbage paths to cmd_upload_file (ENOENT
// toast per drop) or aborts the wrong transfer class.
describe('isDropStreamItem truth table', () => {
    it('true for stream-direct markers', () => {
        expect(isDropStreamItem({ path: 'nobuf-drop-stream://report.pdf' })).toBe(true);
        expect(isDropStreamItem({ path: 'nobuf-drop-stream://' })).toBe(true);
    });

    it('false for real filesystem paths, URLs, and staged temp paths', () => {
        expect(isDropStreamItem({ path: 'C:\\Users\\x\\file.bin' })).toBe(false);
        expect(isDropStreamItem({ path: 'D:/data/archive.zip' })).toBe(false);
        expect(isDropStreamItem({ path: 'https://example.com/f.mp4' })).toBe(false);
        // Staging-era temp path must NOT match (it legitimately uses cmd_upload_file).
        expect(isDropStreamItem({
            path: 'C:\\Users\\x\\AppData\\Local\\Temp\\nobuf_dropped\\ab12-file.bin',
        })).toBe(false);
    });

    it('false when a prefix merely contains the scheme mid-string', () => {
        expect(isDropStreamItem({ path: 'C:\\nobuf-drop-stream://weird' })).toBe(false);
    });
});
