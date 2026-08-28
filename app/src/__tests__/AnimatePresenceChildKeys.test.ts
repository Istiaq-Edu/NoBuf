// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// framer-motion keys every AnimatePresence child with `child.key || ""`
// (node_modules/framer-motion/.../AnimatePresence/utils.mjs). Two unkeyed
// children therefore BOTH resolve to "" and collide, which React reports as
// "Encountered two children with the same key, ``" and which makes
// framer-motion's presence bookkeeping drop/duplicate exit animations.
//
// Dashboard.tsx shipped four unkeyed children inside one AnimatePresence, two
// of them ALWAYS mounted (RemoteUploadModal, SplitUploadModal) — so the warning
// fired on every render at idle, and modal exit animations shared one slot.
//
// Same pattern as DropOverlayLifecycle.test.ts: bind to the SHIPPED file bytes.

function src(rel: string): string {
    return readFileSync(path.resolve(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
}

/** Every .tsx under src/ that mentions AnimatePresence. */
function tsxFilesUsingPresence(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
            const full = path.join(dir, entry);
            if (statSync(full).isDirectory()) {
                if (entry === '__tests__' || entry === 'node_modules') continue;
                walk(full);
                continue;
            }
            if (!entry.endsWith('.tsx')) continue;
            if (readFileSync(full, 'utf8').includes('<AnimatePresence')) {
                out.push(path.relative(process.cwd(), full).replace(/\\/g, '/'));
            }
        }
    };
    walk(path.resolve(process.cwd(), 'src'));
    return out.sort();
}

/**
 * Direct children of an <AnimatePresence> block, as source slices.
 *
 * Needs real JSX tag-depth tracking: a naive scan for the next `/>` splits a
 * multi-line element at its first nested self-closing icon and reports one
 * child as many.
 */
function presenceChildren(body: string): string[] {
    const n = body.length;

    const skipString = (start: number): number => {
        const quote = body[start];
        let j = start + 1;
        while (j < n) {
            if (body[j] === '\\') { j += 2; continue; }
            if (body[j] === quote) return j + 1;
            j++;
        }
        return j;
    };

    /** Consume one tag starting at `<`; attribute braces may contain `>`. */
    const consumeTag = (start: number): { end: number; kind: 'open' | 'close' | 'self' } => {
        let j = start + 1;
        let closing = false;
        if (body[j] === '/') { closing = true; j++; }
        let braces = 0;
        while (j < n) {
            const c = body[j];
            if (c === '"' || c === "'" || c === '`') { j = skipString(j); continue; }
            if (c === '{') { braces++; j++; continue; }
            if (c === '}') { braces--; j++; continue; }
            if (braces === 0) {
                if (c === '/' && body[j + 1] === '>') return { end: j + 2, kind: 'self' };
                if (c === '>') return { end: j + 1, kind: closing ? 'close' : 'open' };
            }
            j++;
        }
        return { end: n, kind: closing ? 'close' : 'open' };
    };

    const children: string[] = [];
    let i = 0;

    while (i < n) {
        const c = body[i];

        // `{cond && (<Thing />)}` — one expression child, braces balance it
        if (c === '{') {
            const start = i;
            let braces = 0;
            while (i < n) {
                const d = body[i];
                if (d === '"' || d === "'" || d === '`') { i = skipString(i); continue; }
                if (d === '{') braces++;
                if (d === '}') { braces--; i++; if (braces === 0) break; continue; }
                i++;
            }
            children.push(body.slice(start, i));
            continue;
        }

        // `<Thing />` or `<Thing>…</Thing>` — one element child
        if (c === '<') {
            const start = i;
            let depth = 0;
            while (i < n) {
                if (body[i] !== '<') { i++; continue; }
                const tag = consumeTag(i);
                i = tag.end;
                if (tag.kind === 'open') depth++;
                if (tag.kind === 'close') depth--;
                if (depth === 0) break;
            }
            children.push(body.slice(start, i));
            continue;
        }

        i++;
    }

    return children.filter(child => child.includes('<'));
}

/** Every <AnimatePresence>...</AnimatePresence> body in a source file. */
function presenceBlocks(source: string): string[] {
    const blocks: string[] = [];
    let from = 0;
    for (;;) {
        const open = source.indexOf('<AnimatePresence', from);
        if (open === -1) break;
        const bodyStart = source.indexOf('>', open);
        const close = source.indexOf('</AnimatePresence>', bodyStart);
        if (bodyStart === -1 || close === -1) break;
        blocks.push(source.slice(bodyStart + 1, close));
        from = close + 1;
    }
    return blocks;
}

describe('AnimatePresence child keys', () => {
    it('framer-motion still keys children with `child.key || ""`', () => {
        // If this assumption ever changes upstream, the rest of this file's
        // reasoning is void — fail loudly rather than guard a dead invariant.
        const utils = readFileSync(
            path.resolve(process.cwd(), 'node_modules/framer-motion/dist/es/components/AnimatePresence/utils.mjs'),
            'utf8',
        );
        expect(utils).toContain('child.key || ""');
    });

    it('no AnimatePresence block has two or more unkeyed children', () => {
        const offenders: string[] = [];

        for (const rel of tsxFilesUsingPresence()) {
            const source = src(rel);
            presenceBlocks(source).forEach((body, blockIdx) => {
                const unkeyed = presenceChildren(body).filter(c => !/\bkey=/.test(c));
                if (unkeyed.length > 1) {
                    offenders.push(`${rel} block#${blockIdx}: ${unkeyed.length} unkeyed children`);
                }
            });
        }

        expect(offenders).toEqual([]);
    });

    it('every child of the Dashboard modal-presence block carries an explicit key', () => {
        const body = presenceBlocks(src('src/components/Dashboard.tsx'))[0];
        expect(body).toBeTruthy();

        const children = presenceChildren(body);
        // Guard the parser itself: this block ships 8 children today.
        expect(children.length).toBeGreaterThanOrEqual(7);

        for (const child of children) {
            expect(child, `unkeyed AnimatePresence child: ${child.slice(0, 80)}`).toMatch(/\bkey=/);
        }
    });

    it('the always-mounted modals are keyed (they collided on "" every render)', () => {
        const s = src('src/components/Dashboard.tsx');
        expect(s).toContain('key="remote-upload-modal"');
        expect(s).toContain('key="split-upload-modal"');
        expect(s).toContain('key="oversize-drop-choice"');
        expect(s).toContain('key="archive-viewer"');
    });
});
