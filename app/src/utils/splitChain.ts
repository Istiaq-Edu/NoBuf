// Split-part chain model for Phase D seamless playback.
//
// Naming produced by the split uploader (double-nested):
//   `<jobid8>-<Stem>.part<outer>.part<inner>.<ext>`
// e.g. `ksz4peq6d-Movie.part01.part07.mp4`
//   jobid8   — per-job random prefix (DIFFERS between jobs of the same video)
//   outer    — the big part number shown in the split screen (1-based)
//   inner    — sequential segment inside that part's upload (1-based)
// Legacy single-level shape `<Stem>.part<n>.<ext>` also accepted (inner = 1).
//
// Grouping: files share a chain when Stem matches (job prefix + both indices
// ignored). Playable chain = consecutive outers starting at 1; anything after
// the first missing outer renders standalone (gap orphans are never hidden).

import type { TelegramFile } from '../types';

export interface ChainDoc {
    id: string;
    name: string;
    size: number;
    /** Seconds (from Telegram metadata) — drives the virtual timeline. */
    duration: number;
}

export interface SplitChain {
    kind: 'chain';
    stem: string;
    ext: string;
    /** Flat playback order: outer asc, then inner asc. */
    docs: ChainDoc[];
    /** Number of distinct consecutive outers included. */
    outerCount: number;
    totalDuration: number;
    totalSize: number;
}

export type CollapseItem =
    | { kind: 'single'; file: TelegramFile }
    | { kind: 'chain'; chain: SplitChain };

interface ParsedName {
    stem: string;
    outer: number;
    inner: number;
    ext: string;
}

const RE_DOUBLE = /^[0-9a-z]{6,16}-(.+)\.part(\d+)\.part(\d+)\.([^.]+)$/i;
const RE_SINGLE = /^(.+)\.part(\d+)\.([^.]+)$/i;

export function parseSplitName(name: string): ParsedName | null {
    const m = RE_DOUBLE.exec(name);
    if (m) {
        const outer = parseInt(m[2], 10);
        const inner = parseInt(m[3], 10);
        if (!Number.isFinite(outer) || !Number.isFinite(inner) || outer < 1 || inner < 1) return null;
        return { stem: m[1], outer, inner, ext: m[4].toLowerCase() };
    }
    const s = RE_SINGLE.exec(name);
    if (s) {
        const outer = parseInt(s[2], 10);
        if (!Number.isFinite(outer) || outer < 1) return null;
        return { stem: s[1], outer, inner: 1, ext: s[3].toLowerCase() };
    }
    return null;
}

/**
 * Collapse a listing into chains + singles, preserving display order.
 * A stem group becomes a chain when its consecutive-from-1 prefix spans at
 * least 2 documents. Everything else passes through untouched; gap orphans
 * render individually.
 */
export function collapseParts(files: TelegramFile[]): CollapseItem[] {
    interface Entry { outer: number; inner: number; f: TelegramFile }
    const groups = new Map<string, { ext: string; entries: Entry[] }>();

    for (const f of files) {
        const p = parseSplitName(f.name);
        if (!p) continue;
        let g = groups.get(p.stem);
        if (!g) { g = { ext: p.ext, entries: [] }; groups.set(p.stem, g); }
        g.entries.push({ outer: p.outer, inner: p.inner, f });
    }

    // Build each group's playable prefix (consecutive outers from 1).
    const chains = new Map<string, SplitChain>();
    for (const [stem, g] of groups) {
        g.entries.sort((a, b) => (a.outer - b.outer) || (a.inner - b.inner));
        let expectOuter = 1;
        const docs: ChainDoc[] = [];
        for (let i = 0; i < g.entries.length; i++) {
            const e = g.entries[i];
            if (e.outer !== expectOuter) break;
            docs.push({
                id: String(f_id(e.f)),
                name: e.f.name,
                size: e.f.size,
                duration: Number(e.f.duration) || 0,
            });
            // Advance outer when the next entry moves to a new one.
            const next = g.entries[i + 1];
            if (next && next.outer !== e.outer) expectOuter++;
        }
        if (docs.length < 2) continue; // lone part(s): nothing to chain yet

        const outerCount = new Set(docs.map(d => d.name)).size > 0
            ? new Set(docs.map(d => parseSplitName(d.name)?.outer ?? 0)).size
            : 0;
        const totalDuration = docs.reduce((s, d) => s + d.duration, 0);
        const totalSize = docs.reduce((s, d) => s + d.size, 0);
        chains.set(stem, {
            kind: 'chain',
            stem,
            ext: g.ext,
            docs,
            outerCount,
            totalDuration,
            totalSize,
        });
    }

    // Emit in original order: each chain once (at its first member), gap
    // orphans and non-parts as singles.
    const emitted = new Set<string>();
    const out: CollapseItem[] = [];
    for (const f of files) {
        const p = parseSplitName(f.name);
        if (!p) { out.push({ kind: 'single', file: f }); continue; }
        const chain = chains.get(p.stem);
        const fid = String(f_id(f));
        if (chain && chain.docs.some(d => d.id === fid)) {
            if (!emitted.has(p.stem)) {
                emitted.add(p.stem);
                out.push({ kind: 'chain', chain });
            }
            continue;
        }
        out.push({ kind: 'single', file: f });
    }
    return out;
}

/** Virtual timeline: global time → (doc index, offset inside it). */
export function globalTimeToDoc(chain: SplitChain, t: number): { index: number; offset: number } {
    let acc = 0;
    for (let i = 0; i < chain.docs.length; i++) {
        const d = chain.docs[i].duration;
        if (t < acc + d || i === chain.docs.length - 1) {
            return { index: i, offset: Math.max(0, Math.min(t - acc, d || t - acc)) };
        }
        acc += d;
    }
    return { index: 0, offset: 0 };
}

/** Doc-local position → global virtual-timeline time. */
export function docToGlobalTime(chain: SplitChain, index: number, offset: number): number {
    let acc = 0;
    for (let i = 0; i < Math.min(index, chain.docs.length); i++) acc += chain.docs[i].duration;
    const cur = chain.docs[Math.min(index, chain.docs.length - 1)]?.duration ?? Infinity;
    return acc + Math.max(0, Math.min(offset, cur));
}

function f_id(f: TelegramFile): string | number {
    return (f as unknown as { id: string | number }).id;
}
