// Split-part chain model: naming convention parsing, listing collapse, and the
// virtual timeline (Σ part durations ⇄ global time mapping).
//
// Naming convention produced by the split uploader: `<stem>.part<N>.<ext>`
// with N zero-padded to max(2, digits(count)) — part01…part99, part100+.
// Parts are consecutive Telegram messages; playback chains to the FIRST
// missing index (gap rule) — anything after a hole is invisible to the chain.

export interface ChainPart {
    id: number;
    name: string;
    size: number;
    /** Duration in seconds from Telegram media metadata. */
    duration: number;
}

export interface SplitChain {
    kind: 'chain';
    /** Shared stem, e.g. "Movie.mkv" parts → stem "Movie". */
    stem: string;
    ext: string;
    /** Contiguous parts starting at part01, ordered. */
    parts: ChainPart[];
    /** Σ part durations (virtual timeline length). */
    totalDuration: number;
    totalSize: number;
}

export type DisplayItem =
    | SplitChain
    | { kind: 'single'; file: TelegramFileLite };

interface TelegramFileLite {
    id: number;
    name: string;
    size: number;
    duration?: number;
}

const PART_RE = /^(.*)\.part(\d{2,})\.([A-Za-z0-9]+)$/;

/** Parse `<stem>.part<N>.<ext>`. Returns null for non-part names. */
export function parsePartName(name: string): { stem: string; idx: number; ext: string } | null {
    const m = PART_RE.exec(name);
    if (!m) return null;
    return { stem: m[1], idx: parseInt(m[2], 10), ext: m[3] };
}

/**
 * Collapse a flat file listing into display items: consecutive split parts
 * sharing a stem become ONE chain (playing to the first missing index);
 * everything else passes through as singles.
 */
export function collapseParts<T extends TelegramFileLite>(files: T[]): Array<SplitChain | { kind: 'single'; file: T }> {
    const byStem = new Map<string, { ext: string; parts: Array<{ idx: number; file: T }> }>();
    const out: Array<SplitChain | { kind: 'single'; file: T }> = [];
    const consumed = new Set<number>();

    for (const f of files) {
        const p = parsePartName(f.name);
        if (!p) continue;
        let g = byStem.get(p.stem);
        if (!g) { g = { ext: p.ext, parts: [] }; byStem.set(p.stem, g); }
        g.parts.push({ idx: p.idx, file: f });
        consumed.add(f.id);
    }

    for (const f of files) {
        if (!consumed.has(f.id)) {
            out.push({ kind: 'single', file: f });
            continue;
        }
        const p = parsePartName(f.name)!;
        // Emit the stem group once, when we reach its LOWEST-index member.
        const g = byStem.get(p.stem)!;
        const sorted = [...g.parts].sort((a, b) => a.idx - b.idx);
        const minIdx = sorted[0].idx;
        if (p.idx !== minIdx) continue;

        // Contiguity from minIdx: keep while indexes step by exactly 1
        // (gap rule). A group missing part01 has no chain start — every
        // member stays an independent single instead.
        const contiguous: typeof sorted = [];
        let expect = minIdx;
        for (const x of sorted) {
            if (x.idx !== expect) break;
            contiguous.push(x);
            expect++;
        }
        const asSingle = (x: { idx: number; file: T }) => out.push({ kind: 'single', file: x.file });
        if (minIdx !== 1 || contiguous.length === 0) {
            sorted.forEach(asSingle);
            continue;
        }
        // Members AFTER a gap stay visible as singles (never hide files).
        for (const x of sorted.slice(contiguous.length)) asSingle(x);
        out.push({
            kind: 'chain',
            stem: p.stem,
            ext: p.ext,
            parts: contiguous.map(x => ({
                id: x.file.id,
                name: x.file.name,
                size: x.file.size,
                duration: x.file.duration ?? 0,
            })),
            totalDuration: contiguous.reduce((s, x) => s + (x.file.duration ?? 0), 0),
            totalSize: contiguous.reduce((s, x) => s + x.file.size, 0),
        });
    }
    return out;
}

/** Cumulative start time of each part on the virtual timeline. */
export function partStarts(chain: SplitChain): number[] {
    const starts: number[] = [];
    let acc = 0;
    for (const p of chain.parts) {
        starts.push(acc);
        acc += p.duration;
    }
    return starts;
}

export interface PartPosition {
    index: number;
    /** Offset within that part's own timeline. */
    offset: number;
}

/**
 * Global virtual-timeline time → (part, offset). Clamps: t<0 → part0@0;
 * t≥total → LAST part end (caller treats as ended).
 */
export function globalTimeToPart(chain: SplitChain, t: number): PartPosition {
    const starts = partStarts(chain);
    const clamped = Math.max(0, t);
    for (let i = chain.parts.length - 1; i >= 0; i--) {
        if (clamped >= starts[i]) {
            const localDur = chain.parts[i].duration || 0;
            return { index: i, offset: Math.min(clamped - starts[i], localDur) };
        }
    }
    return { index: 0, offset: 0 };
}

/** (part, offset) → global time. Unknown index or bad offset clamps safely. */
export function partToGlobalTime(chain: SplitChain, pos: PartPosition): number {
    if (pos.index < 0 || pos.index >= chain.parts.length) return 0;
    const starts = partStarts(chain);
    const localDur = chain.parts[pos.index].duration || 0;
    const off = Math.max(0, Math.min(pos.offset, localDur));
    return starts[pos.index] + off;
}
