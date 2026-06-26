import { describe, it, expect } from 'vitest';

// Mirror the exact comparator used in FileExplorer.tsx
function naturalCompare(a: string, b: string): number {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

describe('natural alphanumeric sorting', () => {
    it('sorts file1, file2, file10 in numeric order', () => {
        const files = ['file10.mp4', 'file2.mp4', 'file1.mp4'];
        const sorted = [...files].sort(naturalCompare);
        expect(sorted).toEqual(['file1.mp4', 'file2.mp4', 'file10.mp4']);
    });

    it('sorts episode numbers correctly', () => {
        const files = ['Episode 10.mp4', 'Episode 2.mp4', 'Episode 1.mp4', 'Episode 20.mp4'];
        const sorted = [...files].sort(naturalCompare);
        expect(sorted).toEqual(['Episode 1.mp4', 'Episode 2.mp4', 'Episode 10.mp4', 'Episode 20.mp4']);
    });

    it('sorts mixed numbers and letters', () => {
        const files = ['file10a.txt', 'file2b.txt', 'file1a.txt'];
        const sorted = [...files].sort(naturalCompare);
        expect(sorted).toEqual(['file1a.txt', 'file2b.txt', 'file10a.txt']);
    });

    it('handles leading numbers', () => {
        const files = ['10_report.pdf', '2_report.pdf', '1_report.pdf'];
        const sorted = [...files].sort(naturalCompare);
        expect(sorted).toEqual(['1_report.pdf', '2_report.pdf', '10_report.pdf']);
    });

    it('is case-insensitive', () => {
        const files = ['File.txt', 'apple.txt', 'Banana.txt'];
        const sorted = [...files].sort(naturalCompare);
        expect(sorted).toEqual(['apple.txt', 'Banana.txt', 'File.txt']);
    });

    it('handles plain text without numbers', () => {
        const files = ['zebra.txt', 'apple.txt', 'mango.txt'];
        const sorted = [...files].sort(naturalCompare);
        expect(sorted).toEqual(['apple.txt', 'mango.txt', 'zebra.txt']);
    });
});
