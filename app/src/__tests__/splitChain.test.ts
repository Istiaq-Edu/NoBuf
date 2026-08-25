import { describe, it, expect } from 'vitest';
import {
    parsePartName,
    collapseParts,
    partStarts,
    globalTimeToPart,
    partToGlobalTime,
    type SplitChain,
} from '../utils/splitChain';

const f = (id: number, name: string, size = 1000, duration?: number) =>
    ({ id, name, size, duration });

describe('parsePartName', () => {
    it('parses padded and 3-digit names', () => {
        expect(parsePartName('Movie.mkv.part01.mkv')).toEqual({ stem: 'Movie.mkv', idx: 1, ext: 'mkv' });
        expect(parsePartName('Movie.mkv.part13.mp4')).toEqual({ stem: 'Movie.mkv', idx: 13, ext: 'mp4' });
        expect(parsePartName('X.part100.mkv')).toEqual({ stem: 'X', idx: 100, ext: 'mkv' });
    });
    it('rejects non-part names', () => {
        expect(parsePartName('Movie.mkv')).toBeNull();
        expect(parsePartName('part01.mkv')).toBeNull();          // no stem
        expect(parsePartName('Movie.part1.mkv')).toBeNull();     // unpadded single digit
        expect(parsePartName('Movie.part01x.mkv')).toBeNull();
    });
});

describe('collapseParts', () => {
    it('collapses consecutive parts into one chain card', () => {
        const items = collapseParts([
            f(1, 'M.part01.mp4', 700_000_000, 1800),
            f(2, 'M.part02.mp4', 650_000_000, 1750),
            f(9, 'Other.txt'),
        ]);
        expect(items).toHaveLength(2);
        const chain = items[0] as SplitChain;
        expect(chain.kind).toBe('chain');
        expect(chain.stem).toBe('M');
        expect(chain.parts.map(p => p.id)).toEqual([1, 2]);
        expect(chain.totalDuration).toBeCloseTo(3550);
        expect(chain.totalSize).toBe(1_350_000_000);
    });

    it('stops the chain at the FIRST missing index (gap rule)', () => {
        const items = collapseParts([
            f(1, 'M.part01.mp4', 1, 60),
            // part02 missing
            f(3, 'M.part03.mp4', 1, 60),
            f(4, 'M.part04.mp4', 1, 60),
        ]);
        const chain = items.find(i => i.kind === 'chain') as SplitChain;
        expect(chain.parts.map(p => p.id)).toEqual([1]);
        // Orphaned later parts still visible as singles (user can play/delete them).
        const singles = items.filter(i => i.kind === 'single');
        expect(singles.map(s => (s as any).file.name)).toEqual(['M.part03.mp4', 'M.part04.mp4']);
    });

    it('handles out-of-order listing input (sorts internally)', () => {
        const items = collapseParts([
            f(3, 'M.part03.mp4', 1, 10),
            f(1, 'M.part01.mp4', 1, 20),
            f(2, 'M.part02.mp4', 1, 30),
        ]);
        const chain = items[0] as SplitChain;
        expect(chain.parts.map(p => p.id)).toEqual([1, 2, 3]);
        expect(chain.totalDuration).toBe(60);
    });

    it('different stems never merge; same-stem different-ext stays separate groups', () => {
        const items = collapseParts([
            f(1, 'A.part01.mkv', 1, 5),
            f(2, 'B.part01.mkv', 1, 6),
            f(3, 'A.part01.mp4', 1, 7),
        ]);
        const chains = items.filter(i => i.kind === 'chain') as SplitChain[];
        expect(chains).toHaveLength(3);
        expect(chains.every(c => c.parts.length === 1)).toBe(true);
    });
});

describe('virtual timeline mapping', () => {
    const chain: SplitChain = {
        kind: 'chain',
        stem: 'M',
        ext: 'mp4',
        parts: [
            { id: 1, name: 'M.part01.mp4', size: 1, duration: 60 },
            { id: 2, name: 'M.part02.mp4', size: 1, duration: 90 },
            { id: 3, name: 'M.part03.mp4', size: 1, duration: 45 },
        ],
        totalDuration: 195,
        totalSize: 3,
    };

    it('computes cumulative starts', () => {
        expect(partStarts(chain)).toEqual([0, 60, 150]);
    });

    it('maps global → part/offset on boundaries and interiors', () => {
        expect(globalTimeToPart(chain, 0)).toEqual({ index: 0, offset: 0 });
        expect(globalTimeToPart(chain, 59.9)).toEqual({ index: 0, offset: 59.9 });
        expect(globalTimeToPart(chain, 60)).toEqual({ index: 1, offset: 0 });
        expect(globalTimeToPart(chain, 150)).toEqual({ index: 2, offset: 0 });
        expect(globalTimeToPart(chain, 194.5)).toEqual({ index: 2, offset: 44.5 });
    });

    it('round-trips random times within bounds (property)', () => {
        let seed = 42;
        const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        for (let i = 0; i < 500; i++) {
            const t = rand() * 195;
            const pos = globalTimeToPart(chain, t);
            const back = partToGlobalTime(chain, pos);
            // Round-trip exact except float dust.
            expect(Math.abs(back - t)).toBeLessThan(1e-9);
        }
    });

    it('clamps out-of-bounds safely', () => {
        expect(globalTimeToPart(chain, -5)).toEqual({ index: 0, offset: 0 });
        const end = globalTimeToPart(chain, 500);
        expect(end.index).toBe(2);
        expect(end.offset).toBeLessThanOrEqual(45);
        expect(partToGlobalTime(chain, { index: 7, offset: 3 })).toBe(0);
        // Oversized offset clamps to that part's END on the virtual timeline.
        expect(partToGlobalTime(chain, { index: 1, offset: 9999 })).toBe(150);
    });
});
