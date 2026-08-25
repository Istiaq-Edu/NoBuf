import { describe, it, expect } from 'vitest';
import {
    parseSplitName,
    collapseParts,
    globalTimeToDoc,
    docToGlobalTime,
    type SplitChain,
} from '../utils/splitChain';
import type { TelegramFile } from '../types';

// Real-world shape: <jobid8>-<Stem>.part<outer>.part<inner>.<ext>
const mk = (id: number, name: string, sizeMB = 60, durS = 100): TelegramFile =>
    ({ id, name, size: sizeMB * 1_000_000, duration: durS, sizeStr: '', type: 'file' } as unknown as TelegramFile);

describe('parseSplitName', () => {
    it('parses the double-nested uploader shape', () => {
        const p = parseSplitName('ksz4peq6d-Movie.part01.part07.mp4');
        expect(p).toEqual({ stem: 'Movie', outer: 1, inner: 7, ext: 'mp4' });
    });

    it('parses legacy single-level names', () => {
        expect(parseSplitName('Film.mkv.part3.mkv')).toEqual({ stem: 'Film.mkv', outer: 3, inner: 1, ext: 'mkv' });
    });

    it('rejects ordinary files', () => {
        expect(parseSplitName('holiday.mp4')).toBeNull();
        expect(parseSplitName('report.pdf')).toBeNull();
    });
});

describe('collapseParts — cross-job chains', () => {
    it('chains parts uploaded as separate jobs (different job prefixes)', () => {
        const files = [
            mk(1, 'ksz4peq6d-Movie.part01.part01.mp4'),
            mk(2, 'ksz4peq6d-Movie.part01.part02.mp4'),
            mk(3, '9r80ddrwq-Movie.part02.part01.mp4'),
            mk(4, '9r80ddrwq-Movie.part02.part02.mp4'),
            mk(5, '6nkwzwr8p-Movie.part03.part01.mp4'),
        ];
        const items = collapseParts(files);
        const chains = items.filter(i => i.kind === 'chain') as { kind: 'chain'; chain: SplitChain }[];
        expect(chains).toHaveLength(1);
        const c = chains[0].chain;
        expect(c.stem).toBe('Movie');
        expect(c.docs.map(d => d.id)).toEqual(['1', '2', '3', '4', '5']);
        expect(c.outerCount).toBe(3);
        expect(c.totalSize).toBe(files.reduce((s, f) => s + f.size, 0));
    });

    it('stops the chain at a missing outer and keeps gap orphans visible', () => {
        const files = [
            mk(1, 'aaaaaaa1-G.part01.part01.mp4'),
            mk(2, 'bbbbbbb2-G.part02.part01.mp4'),
            mk(3, 'ddddddd4-G.part04.part01.mp4'), // part03 missing → orphan
        ];
        const items = collapseParts(files);
        const chains = items.filter(i => i.kind === 'chain');
        expect(chains).toHaveLength(1);
        const c = (chains[0] as { chain: SplitChain }).chain;
        expect(c.docs.map(d => d.id)).toEqual(['1', '2']);
        const orphans = items.filter(i => i.kind === 'single');
        expect(orphans).toHaveLength(1);
        expect(((orphans[0] as { file: TelegramFile }).file).name).toContain('part04');
    });

    it('leaves non-part files untouched', () => {
        const files = [mk(1, 'note.txt'), mk(2, 'video.mp4')];
        const items = collapseParts(files);
        expect(items.every(i => i.kind === 'single')).toBe(true);
    });

    it('does not chain a lone part group', () => {
        const files = [mk(1, 'aaaaaaa1-Solo.part01.part01.mp4')];
        const items = collapseParts(files);
        expect(items.every(i => i.kind === 'single')).toBe(true);
    });
});

describe('virtual timeline', () => {
    const files = [
        mk(1, 'aaaaaaaa-M.part01.part01.mp4', 10, 150),
        mk(2, 'aaaaaaaa-M.part01.part02.mp4', 10, 150),
        mk(3, 'bbbbbbbb-M.part02.part01.mp4', 10, 90),
        mk(4, 'cccccccc-M.part03.part01.mp4', 10, 120),
    ];
    const chain = (collapseParts(files)[0] as { kind: 'chain'; chain: SplitChain }).chain;

    it('builds Σ durations', () => {
        expect(chain.totalDuration).toBe(150 + 150 + 90 + 120); // 510
    });

    it('maps global time to the right doc+offset', () => {
        expect(globalTimeToDoc(chain, 0)).toEqual({ index: 0, offset: 0 });
        expect(globalTimeToDoc(chain, 149)).toEqual({ index: 0, offset: 149 });
        // t=150 sits at the boundary → clamped to the END of doc 0 (index 1
        // would be equally valid; we clamp to the earlier doc).
        const b = globalTimeToDoc(chain, 200);
        expect(b.index === 1 || b.index === 2).toBe(true);
        expect(docToGlobalTime(chain, b.index, b.offset)).toBe(200);
        // 150+150+90 = 390 consumed before doc index 3.
        expect(globalTimeToDoc(chain, 400)).toEqual({ index: 3, offset: 10 });
    });

    it('round-trips both directions (property sweep)', () => {
        let checked = 0;
        for (let t = 0; t <= 500; t += 7) {
            const { index, offset } = globalTimeToDoc(chain, t);
            const back = docToGlobalTime(chain, index, offset);
            expect(Math.abs(back - Math.min(t, 510))).toBeLessThanOrEqual(1);
            checked++;
        }
        expect(checked).toBeGreaterThan(60);
    });
});
